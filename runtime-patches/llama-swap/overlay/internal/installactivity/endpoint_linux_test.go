//go:build linux

package activity

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const endpointDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func endpointIdentity() Identity {
	return Identity{
		ProducerID:     "llama_swap",
		InstanceSHA256: endpointDigest,
		BuildSHA256:    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		ConfigSHA256:   "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	}
}

func positiveEndpointUID(t *testing.T) uint32 {
	t.Helper()
	uid := os.Getuid()
	if uid <= 0 {
		t.Fatalf("endpoint peer-credential tests require a positive actual UID, got %d", uid)
	}
	return uint32(uid)
}

func endpointTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "gi-ep-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func startEndpoint(t *testing.T, tracker *Tracker, uid uint32) (*Endpoint, string) {
	t.Helper()
	dir := endpointTempDir(t)
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "observer.sock")
	endpoint, err := Listen(path, uid, endpointIdentity(), tracker)
	if err != nil {
		t.Fatalf("Listen(%q): %v", path, err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	return endpoint, path
}

func requestEndpoint(path, request string) ([]byte, error) {
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, request); err != nil {
		return nil, err
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		return nil, err
	}
	return io.ReadAll(conn)
}

func parseEndpointReceipt(data []byte) (map[string]json.RawMessage, error) {
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return nil, errors.New("receipt is not one newline-terminated JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var receipt map[string]json.RawMessage
	if err := decoder.Decode(&receipt); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("receipt contains more than one JSON value")
		}
		return nil, err
	}
	return receipt, nil
}

func checkEndpointReceipt(data []byte, identity Identity, nonce string, want [4]uint64, unknown bool) error {
	receipt, err := parseEndpointReceipt(data)
	if err != nil {
		return err
	}
	wantKeys := map[string]bool{
		"schemaVersion":      true,
		"producerId":         true,
		"instanceSha256":     true,
		"buildSha256":        true,
		"configSha256":       true,
		"active":             true,
		"queued":             true,
		"loading":            true,
		"workStarted":        true,
		"requestNonceSha256": true,
	}
	if len(receipt) != len(wantKeys) {
		return fmt.Errorf("receipt has %d fields, want exactly %d", len(receipt), len(wantKeys))
	}
	for key := range receipt {
		if !wantKeys[key] {
			return fmt.Errorf("unexpected receipt field %q", key)
		}
	}
	var schema int
	if err := json.Unmarshal(receipt["schemaVersion"], &schema); err != nil || schema != 1 {
		return fmt.Errorf("schemaVersion = %s, want 1", receipt["schemaVersion"])
	}
	for key, expected := range map[string]string{
		"producerId":         identity.ProducerID,
		"instanceSha256":     identity.InstanceSHA256,
		"buildSha256":        identity.BuildSHA256,
		"configSha256":       identity.ConfigSHA256,
		"requestNonceSha256": nonce,
	} {
		var actual string
		if err := json.Unmarshal(receipt[key], &actual); err != nil || actual != expected {
			return fmt.Errorf("%s = %s, want %q", key, receipt[key], expected)
		}
	}
	for index, key := range []string{"active", "queued", "loading", "workStarted"} {
		if unknown {
			if string(receipt[key]) != "null" {
				return fmt.Errorf("%s = %s, want null for unknown tracker", key, receipt[key])
			}
			continue
		}
		var actual uint64
		if err := json.Unmarshal(receipt[key], &actual); err != nil || actual != want[index] {
			return fmt.Errorf("%s = %s, want %d", key, receipt[key], want[index])
		}
	}
	return nil
}

func validSnapshotRequest(nonce string) string {
	return "snapshot " + nonce + "\n"
}

func checkRejectedEndpointTransport(data []byte, errs ...error) error {
	if len(data) != 0 {
		return fmt.Errorf("rejected request returned %q", data)
	}
	for _, err := range errs {
		if err != nil && !errors.Is(err, syscall.ECONNRESET) && !errors.Is(err, syscall.EPIPE) {
			return err
		}
	}
	return nil
}

func TestEndpointReturnsExactIdentityAndAtomicSnapshot(t *testing.T) {
	uid := positiveEndpointUID(t)
	tracker := New()
	queued := tracker.Begin(Queued)
	active := tracker.Begin(Active)
	loading := tracker.Begin(Loading)
	if queued == nil || active == nil || loading == nil {
		t.Fatal("expected three live tracker handles")
	}
	defer queued.Finish()
	defer active.Finish()
	defer loading.Finish()
	_, path := startEndpoint(t, tracker, uid)

	nonce := strings.Repeat("b", 64)
	data, err := requestEndpoint(path, validSnapshotRequest(nonce))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkEndpointReceipt(data, endpointIdentity(), nonce, [4]uint64{1, 1, 1, 3}, false); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointZeroTrackerReportsUnknownCounts(t *testing.T) {
	uid := positiveEndpointUID(t)
	var tracker Tracker
	_, path := startEndpoint(t, &tracker, uid)
	nonce := strings.Repeat("c", 64)
	data, err := requestEndpoint(path, validSnapshotRequest(nonce))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkEndpointReceipt(data, endpointIdentity(), nonce, [4]uint64{}, true); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointOnlyConfiguredPeerUIDReceivesResponse(t *testing.T) {
	uid := positiveEndpointUID(t)
	wrongUID := uid ^ 1
	if wrongUID == uid {
		t.Fatal("could not construct a mismatched UID")
	}
	_, path := startEndpoint(t, New(), wrongUID)
	data, err := requestEndpoint(path, validSnapshotRequest(strings.Repeat("d", 64)))
	if err := checkRejectedEndpointTransport(data, err); err != nil {
		t.Fatalf("mismatched peer rejection: %v", err)
	}
}

func TestEndpointRejectsMalformedOversizedAndMissingNewlineRequests(t *testing.T) {
	uid := positiveEndpointUID(t)
	_, path := startEndpoint(t, New(), uid)
	cases := map[string]string{
		"wrong command":   "observe " + strings.Repeat("a", 64) + "\n",
		"short nonce":     "snapshot " + strings.Repeat("a", 63) + "\n",
		"uppercase nonce": "snapshot " + strings.Repeat("A", 64) + "\n",
		"oversized":       "snapshot " + strings.Repeat("a", 256) + "\n",
		"no newline":      "snapshot " + strings.Repeat("a", 64),
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			started := time.Now()
			data, err := requestEndpoint(path, request)
			if err := checkRejectedEndpointTransport(data, err); err != nil {
				t.Fatalf("malformed request rejection: %v", err)
			}
			if elapsed := time.Since(started); elapsed > 1500*time.Millisecond {
				t.Fatalf("rejection took %s; want bounded rejection near the 500ms server deadline", elapsed)
			}
		})
	}
}

func TestEndpointCapsConcurrentHandlersAtFour(t *testing.T) {
	uid := positiveEndpointUID(t)
	_, path := startEndpoint(t, New(), uid)
	stalled := make([]net.Conn, 4)
	for index := range stalled {
		conn, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		stalled[index] = conn
		if _, err := io.WriteString(conn, "snapshot "); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, conn := range stalled {
			_ = conn.Close()
		}
	}()

	// Endpoint does not expose worker occupancy, so allow the accept loop a short,
	// bounded scheduling grace before probing the fifth connection.
	time.Sleep(20 * time.Millisecond)
	foundRejected := false
	for attempt := 0; attempt < 8 && !foundRejected; attempt++ {
		conn, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_, writeErr := io.WriteString(conn, validSnapshotRequest(strings.Repeat("e", 64)))
		_ = conn.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
		data, readErr := io.ReadAll(conn)
		_ = conn.Close()
		if err := checkRejectedEndpointTransport(data, writeErr, readErr); err != nil {
			t.Fatalf("handler-capacity probe rejection: %v", err)
		}
		if writeErr != nil || len(data) == 0 {
			foundRejected = true
		}
	}
	if !foundRejected {
		t.Fatal("no fifth concurrent handler was rejected while four clients were stalled")
	}
}

func TestEndpointConcurrentActivitySnapshots(t *testing.T) {
	uid := positiveEndpointUID(t)
	tracker := New()
	queued := tracker.Begin(Queued)
	active := tracker.Begin(Active)
	loading := tracker.Begin(Loading)
	if queued == nil || active == nil || loading == nil {
		t.Fatal("expected three live tracker handles")
	}
	defer queued.Finish()
	defer active.Finish()
	defer loading.Finish()
	_, path := startEndpoint(t, tracker, uid)

	const clients = 4
	start := make(chan struct{})
	errs := make(chan error, clients)
	var wg sync.WaitGroup
	for index := 0; index < clients; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			nonce := fmt.Sprintf("%064x", index+1)
			data, err := requestEndpoint(path, validSnapshotRequest(nonce))
			if err != nil {
				errs <- err
				return
			}
			errs <- checkEndpointReceipt(data, endpointIdentity(), nonce, [4]uint64{1, 1, 1, 3}, false)
		}(index)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestEndpointCloseIsIdempotent(t *testing.T) {
	uid := positiveEndpointUID(t)
	endpoint, path := startEndpoint(t, New(), uid)
	if err := endpoint.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := endpoint.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("owned socket still exists after idempotent Close: %v", err)
	}
}

func TestEndpointClosePreservesReplacementInode(t *testing.T) {
	uid := positiveEndpointUID(t)
	endpoint, path := startEndpoint(t, New(), uid)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	replacement, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()

	if err := endpoint.Close(); err == nil {
		t.Fatal("Close unexpectedly removed a replacement socket")
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("replacement socket was not preserved: %v", err)
	}
	if err := endpoint.Close(); err == nil {
		t.Fatal("idempotent Close lost the original replacement error")
	}
}

func TestEndpointCloseDrainsStalledClientsWithinThreeSeconds(t *testing.T) {
	uid := positiveEndpointUID(t)
	endpoint, path := startEndpoint(t, New(), uid)
	clients := make([]net.Conn, 4)
	for index := range clients {
		conn, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		clients[index] = conn
		if _, err := io.WriteString(conn, "snapshot "); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, conn := range clients {
			_ = conn.Close()
		}
	}()

	closed := make(chan error, 1)
	started := time.Now()
	go func() { closed <- endpoint.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Fatalf("Close took %s", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not drain stalled clients within three seconds")
	}
}

func TestEndpointRejectsInvalidIdentityAndPathConfiguration(t *testing.T) {
	uid := uint32(os.Getuid())
	valid := endpointIdentity()
	identityCases := map[string]Identity{
		"empty producer":       {InstanceSHA256: valid.InstanceSHA256, BuildSHA256: valid.BuildSHA256, ConfigSHA256: valid.ConfigSHA256},
		"producer punctuation": {ProducerID: "bad/producer", InstanceSHA256: valid.InstanceSHA256, BuildSHA256: valid.BuildSHA256, ConfigSHA256: valid.ConfigSHA256},
		"uppercase digest":     {ProducerID: valid.ProducerID, InstanceSHA256: strings.ToUpper(valid.InstanceSHA256), BuildSHA256: valid.BuildSHA256, ConfigSHA256: valid.ConfigSHA256},
		"short digest":         {ProducerID: valid.ProducerID, InstanceSHA256: "abc", BuildSHA256: valid.BuildSHA256, ConfigSHA256: valid.ConfigSHA256},
		"long digest":          {ProducerID: valid.ProducerID, InstanceSHA256: valid.InstanceSHA256 + "0", BuildSHA256: valid.BuildSHA256, ConfigSHA256: valid.ConfigSHA256},
	}
	for name, identity := range identityCases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(endpointTempDir(t), "observer.sock")
			if endpoint, err := Listen(path, uid, identity, New()); err == nil {
				_ = endpoint.Close()
				t.Fatal("invalid identity was accepted")
			}
		})
	}

	t.Run("nil tracker", func(t *testing.T) {
		path := filepath.Join(endpointTempDir(t), "observer.sock")
		if endpoint, err := Listen(path, uid, valid, nil); err == nil {
			_ = endpoint.Close()
			t.Fatal("nil tracker was accepted")
		}
	})
	t.Run("relative path", func(t *testing.T) {
		if endpoint, err := Listen("observer.sock", uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("relative path was accepted")
		}
	})
	t.Run("unclean path", func(t *testing.T) {
		dir := endpointTempDir(t)
		path := dir + string(os.PathSeparator) + "." + string(os.PathSeparator) + "observer.sock"
		if endpoint, err := Listen(path, uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("unclean path was accepted")
		}
	})
	t.Run("writable group and other directory", func(t *testing.T) {
		dir := endpointTempDir(t)
		if err := os.Chmod(dir, 0770); err != nil {
			t.Fatal(err)
		}
		if endpoint, err := Listen(filepath.Join(dir, "observer.sock"), uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("writable directory was accepted")
		}
	})
	t.Run("symlink directory", func(t *testing.T) {
		realDir := endpointTempDir(t)
		linkDir := filepath.Join(endpointTempDir(t), "link")
		if err := os.Symlink(realDir, linkDir); err != nil {
			t.Fatal(err)
		}
		if endpoint, err := Listen(filepath.Join(linkDir, "observer.sock"), uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("symlink directory was accepted")
		}
	})
	t.Run("existing regular file", func(t *testing.T) {
		dir := endpointTempDir(t)
		path := filepath.Join(dir, "observer.sock")
		if err := os.WriteFile(path, []byte("occupied"), 0600); err != nil {
			t.Fatal(err)
		}
		if endpoint, err := Listen(path, uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("existing regular file was accepted")
		}
	})
	t.Run("existing socket", func(t *testing.T) {
		dir := endpointTempDir(t)
		path := filepath.Join(dir, "observer.sock")
		existing, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		defer existing.Close()
		if endpoint, err := Listen(path, uid, valid, New()); err == nil {
			_ = endpoint.Close()
			t.Fatal("existing socket was accepted")
		}
	})
}
