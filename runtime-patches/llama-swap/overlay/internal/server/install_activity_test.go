package server

import (
	"context"
	"github.com/mostlygeek/llama-swap/internal/config"
	activity "github.com/mostlygeek/llama-swap/internal/installactivity"
	"github.com/mostlygeek/llama-swap/internal/process"
	"github.com/mostlygeek/llama-swap/internal/swaputil"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestInstallPublicBodyRemainsCountedUntilHandlerSettles(t *testing.T) {
	before := activity.Process().Snapshot()
	if before.Queued == nil {
		t.Fatal("unexpected unknown baseline")
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	entered, done := make(chan struct{}), make(chan struct{})
	server := &Server{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		_, _ = io.Copy(io.Discard, r.Body)
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", reader).WithContext(ctx)
	go func() { defer close(done); server.ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not start")
	}
	during := activity.Process().Snapshot()
	if during.Queued == nil || *during.Queued != *before.Queued+1 || *during.WorkStarted <= *before.WorkStarted {
		t.Fatal("accepted body/handler waiting is not accounted before dispatch")
	}
	cancel()
	afterCancel := activity.Process().Snapshot()
	if afterCancel.Queued == nil || *afterCancel.Queued != *during.Queued {
		t.Fatal("client cancellation prematurely settled work")
	}
	writer.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not settle")
	}
	after := activity.Process().Snapshot()
	if after.Queued == nil || *after.Queued != *before.Queued {
		t.Fatal("settled handler leaked activity")
	}
}

func TestInstallAuditedHealthDoesNotStartWork(t *testing.T) {
	before := activity.Process().Snapshot()
	server := &Server{handler: http.HandlerFunc(handleHealth)}
	server.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/health", nil))
	after := activity.Process().Snapshot()
	if before.WorkStarted == nil || after.WorkStarted == nil || *before.WorkStarted != *after.WorkStarted {
		t.Fatal("read-only health counted as work")
	}
}

func TestInstallDetachedCapabilityProbeRemainsCounted(t *testing.T) {
	before := activity.Process().Snapshot()
	if before.Loading == nil {
		t.Fatal("unknown baseline")
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var started, released sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started.Do(func() { close(entered) })
		<-release
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/props" {
			_, _ = io.WriteString(w, llamaServerProps)
		} else {
			_, _ = io.WriteString(w, llamaServerModels)
		}
	}))
	defer upstream.Close()
	defer released.Do(func() { close(release) })
	server := capServer(t, "model", config.ModelConfig{Proxy: upstream.URL})
	server.onProcessStateChange(swaputil.ProcessStateChangeEvent{ProcessName: "model", NewState: string(process.StateReady)})
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("capability probe did not start")
	}
	during := activity.Process().Snapshot()
	if during.Loading == nil || *during.Loading <= *before.Loading {
		t.Fatal("detached capability probe is not accounted")
	}
	released.Do(func() { close(release) })
	deadline := time.After(3 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		after := activity.Process().Snapshot()
		if after.Loading != nil && *after.Loading == *before.Loading {
			return
		}
		select {
		case <-deadline:
			t.Fatal("capability probe did not settle")
		case <-tick.C:
		}
	}
}
