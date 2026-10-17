//go:build linux

// Copied beside the exact owned Go endpoint only by disposable CI. Not a service.
package activity

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestNativeProducerChannel(t *testing.T) {
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || os.Geteuid() != 0 {
		t.Fatal("disposable GitHub-hosted root fixture required")
	}
	probe := os.Getenv("GI_NATIVE_PROBE")
	info, err := os.Lstat(probe)
	if err != nil || !filepath.IsAbs(probe) || !info.Mode().IsRegular() || info.Size() > 16*1024*1024 {
		t.Fatal("invalid native probe")
	}
	const directory = "/run/llama-swap-observer"
	const socket = directory + "/activity.sock"
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal("fixture directory must be absent")
	}
	// Register cleanup before any subsequent operation can fail.
	copiedProbe := directory + "/probe"
	var copiedInfo os.FileInfo
	t.Cleanup(func() {
		if copiedInfo != nil {
			current, err := os.Lstat(copiedProbe)
			if err != nil || !os.SameFile(copiedInfo, current) {
				t.Error("probe replaced; cleanup refused")
				return
			}
			if err := os.Remove(copiedProbe); err != nil {
				t.Error("probe cleanup failed")
			}
		}
		if err := os.Remove(directory); err != nil {
			t.Error("fixture directory cleanup failed")
		}
	})
	// Copy only the compiled fixture into this newly owned traversable directory.
	probeBytes, err := os.ReadFile(probe)
	if err != nil {
		t.Fatal("probe copy read failed")
	}
	if err := os.WriteFile(copiedProbe, probeBytes, 0755); err != nil {
		t.Fatal("probe copy failed")
	}
	copiedInfo, err = os.Lstat(copiedProbe)
	if err != nil {
		t.Fatal("probe identity read failed")
	}
	probe = copiedProbe
	identity := Identity{ProducerID: "llama-swap", InstanceSHA256: strings.Repeat("a", 64),
		BuildSHA256: strings.Repeat("b", 64), ConfigSHA256: strings.Repeat("c", 64)}
	run := func(t *testing.T, mode string) {
		t.Helper()
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, probe, mode, strconv.Itoa(os.Getpid()))
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534}}
		command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
		if err := command.Run(); err != nil {
			t.Fatal("native producer case failed: " + mode)
		}
		if time.Since(started) > 1500*time.Millisecond {
			t.Fatal("native producer deadline exceeded")
		}
	}
	for _, mode := range []string{"busy", "idle", "unknown", "peer-pid", "peer-uid", "start", "instance", "build", "config"} {
		t.Run(mode, func(t *testing.T) {
			tracker := New()
			if mode == "busy" {
				tracker.Begin(Active)
				tracker.Begin(Queued)
				tracker.Begin(Loading)
			} else {
				handle := tracker.Begin(Active)
				handle.Finish()
			}
			if mode == "unknown" {
				tracker.Invalidate()
			}
			endpoint, err := Listen(socket, 65534, identity, tracker)
			if err != nil {
				t.Fatal("owned endpoint startup failed")
			}
			t.Cleanup(func() {
				if err := endpoint.Close(); err != nil {
					t.Error("owned endpoint cleanup failed")
				}
				if err := os.Chown(directory, 0, 0); err != nil {
					t.Error("directory ownership restore failed")
				}
			})
			// Make path ownership match the wrong expected UID while the actual
			// kernel peer remains root: the client must reach SO_PEERCRED refusal.
			if mode == "peer-uid" {
				if os.Chown(directory, 1, 1) != nil || os.Chown(socket, 1, 1) != nil {
					t.Fatal("synthetic chown failed")
				}
			}
			run(t, mode)
		})
	}
	for _, mode := range []string{"replay", "malformed", "oversize", "timeout", "path-changed"} {
		t.Run(mode, func(t *testing.T) {
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
			if err != nil {
				t.Fatal("synthetic endpoint startup failed")
			}
			listener.SetUnlinkOnClose(false)
			owned, err := os.Lstat(socket)
			if err != nil || os.Chmod(socket, 0666) != nil {
				t.Fatal("synthetic endpoint identity failed")
			}
			var workers sync.WaitGroup
			workers.Add(1)
			t.Cleanup(func() {
				listener.Close()
				workers.Wait()
				current, err := os.Lstat(socket)
				if err != nil || !os.SameFile(owned, current) {
					t.Error("synthetic endpoint replaced; cleanup refused")
					return
				}
				if err := os.Remove(socket); err != nil {
					t.Error("synthetic endpoint cleanup failed")
				}
			})
			go func() {
				defer workers.Done()
				previous := ""
				count := 1
				if mode == "replay" {
					count = 2
				}
				for i := 0; i < count; i++ {
					conn, err := listener.AcceptUnix()
					if err != nil {
						return
					}
					if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
						t.Error("synthetic connection deadline failed")
						conn.Close()
						return
					}
					request, err := bufio.NewReaderSize(conn, 128).ReadString('\n')
					if err != nil || len(request) != 74 || !strings.HasPrefix(request, "snapshot ") {
						conn.Close()
						return
					}
					nonce := request[9:73]
					switch mode {
					case "timeout":
						time.Sleep(650 * time.Millisecond)
					case "malformed":
						if _, err := conn.Write([]byte(`{"schemaVersion":1}` + "\n")); err != nil {
							t.Error("malformed fixture write failed")
						}
					case "oversize":
						if _, err := conn.Write([]byte(strings.Repeat("x", 2049))); err != nil {
							t.Error("oversize fixture write failed")
						}
					default:
						tracker := New()
						handle := tracker.Begin(Active)
						handle.Finish()
						if mode == "path-changed" {
							if err := os.Chmod(socket, 0600); err != nil {
								t.Error("path change fixture failed")
							}
						}
						if mode == "replay" && i == 1 {
							if nonce == previous {
								t.Error("nonce unexpectedly reused")
							}
							nonce = previous
						} else {
							previous = nonce
						}
						if err := json.NewEncoder(conn).Encode(receipt{SchemaVersion: 1, Identity: identity,
							Snapshot: tracker.Snapshot(), RequestNonceSHA256: nonce}); err != nil {
							t.Error("synthetic receipt write failed")
						}
					}
					conn.Close()
				}
			}()
			run(t, mode)
		})
	}
}
