//go:build linux

package activity

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var producerPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Identity is immutable for the life of one private endpoint. Config reload must
// invalidate the tracker; it cannot retain an accepted configuration identity.
type Identity struct {
	ProducerID     string `json:"producerId"`
	InstanceSHA256 string `json:"instanceSha256"`
	BuildSHA256    string `json:"buildSha256"`
	ConfigSHA256   string `json:"configSha256"`
}

type receipt struct {
	SchemaVersion int `json:"schemaVersion"`
	Identity
	Snapshot
	RequestNonceSHA256 string `json:"requestNonceSha256"`
}

// Endpoint exposes no inference or control operations. Its path and authorized
// observer UID come only from reviewed service startup, never a request.
type Endpoint struct {
	listener    *net.UnixListener
	path        string
	inode       os.FileInfo
	identity    Identity
	observerUID uint32
	tracker     *Tracker
	done        chan struct{}
	closeOnce   sync.Once
	closeErr    error
}

var errEndpoint = errors.New("private observer endpoint unavailable")

// Listen requires a private, service-owned directory and an absent socket path.
// The socket is connectable across UIDs; SO_PEERCRED is checked before any input
// is read or evidence returned. No TCP listener or public HTTP route is added.
func Listen(path string, observerUID uint32, identity Identity, tracker *Tracker) (*Endpoint, error) {
	if tracker == nil || !producerPattern.MatchString(identity.ProducerID) ||
		!digestPattern.MatchString(identity.InstanceSHA256) || !digestPattern.MatchString(identity.BuildSHA256) ||
		!digestPattern.MatchString(identity.ConfigSHA256) || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errEndpoint
	}
	dir, err := os.Lstat(filepath.Dir(path))
	if err != nil || !dir.IsDir() || dir.Mode().Perm()&0022 != 0 {
		return nil, errEndpoint
	}
	stat, ok := dir.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, errEndpoint
	}
	if _, err = os.Lstat(path); !os.IsNotExist(err) {
		return nil, errEndpoint
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, errEndpoint
	}
	listener.SetUnlinkOnClose(false)
	inode, err := os.Lstat(path)
	if err != nil {
		listener.Close()
		return nil, errEndpoint
	}
	endpoint := &Endpoint{listener: listener, path: path, inode: inode, identity: identity,
		observerUID: observerUID, tracker: tracker, done: make(chan struct{})}
	if err = os.Chmod(path, 0666); err != nil {
		listener.Close()
		endpoint.removeOwned()
		return nil, errEndpoint
	}
	go endpoint.serve()
	return endpoint, nil
}

func (e *Endpoint) serve() {
	defer close(e.done)
	var workers sync.WaitGroup
	slots := make(chan struct{}, 4)
	defer workers.Wait()
	for {
		conn, err := e.listener.AcceptUnix()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
			go func() { defer workers.Done(); defer func() { <-slots }(); e.reply(conn) }()
		default:
			conn.Close()
		}
	}
}

func (e *Endpoint) reply(conn *net.UnixConn) {
	defer conn.Close()
	if conn.SetDeadline(time.Now().Add(500*time.Millisecond)) != nil {
		return
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return
	}
	authorized := false
	if raw.Control(func(fd uintptr) {
		credential, failure := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		authorized = failure == nil && credential.Uid == e.observerUID
	}) != nil || !authorized {
		return
	}
	request, err := bufio.NewReaderSize(conn, 128).ReadSlice('\n')
	if err != nil || len(request) != 74 || string(request[:9]) != "snapshot " ||
		!digestPattern.Match(request[9:73]) {
		return
	}
	output := receipt{SchemaVersion: 1, Identity: e.identity, Snapshot: e.tracker.Snapshot(),
		RequestNonceSHA256: string(request[9:73])}
	// Fixed bounded fields only. No caller-selected reads, paths, content or errors.
	_ = json.NewEncoder(conn).Encode(output)
}

func (e *Endpoint) removeOwned() error {
	current, err := os.Lstat(e.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !os.SameFile(e.inode, current) {
		return errEndpoint
	}
	if os.Remove(e.path) != nil {
		return errEndpoint
	}
	return nil
}

// Close drains the bounded handlers and removes only the socket it created.
func (e *Endpoint) Close() error {
	if e == nil {
		return nil
	}
	e.closeOnce.Do(func() {
		e.listener.Close()
		<-e.done
		e.closeErr = e.removeOwned()
	})
	return e.closeErr
}
