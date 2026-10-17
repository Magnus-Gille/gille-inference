package process

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/mostlygeek/llama-swap/internal/config"
	activity "github.com/mostlygeek/llama-swap/internal/installactivity"
)

func requireInstallResponder(t *testing.T) {
	t.Helper()
	if _, err := os.Stat(simpleResponderPath); err != nil {
		t.Fatalf("synthetic responder fixture is required at %s: %v", simpleResponderPath, err)
	}
}

func installActivityValue(t *testing.T, value *uint64) uint64 {
	t.Helper()
	if value == nil {
		t.Fatal("activity snapshot became unknown")
	}
	return *value
}

func installActivitySnapshot(t *testing.T) activity.Snapshot {
	t.Helper()
	snapshot := activity.Process().Snapshot()
	if snapshot.Active == nil || snapshot.Queued == nil || snapshot.Loading == nil || snapshot.WorkStarted == nil {
		t.Fatalf("activity snapshot became unknown: %+v", snapshot)
	}
	if installActivityValue(t, snapshot.Active) != 0 || installActivityValue(t, snapshot.Queued) != 0 || installActivityValue(t, snapshot.Loading) != 0 {
		t.Fatalf("activity tracker was not idle: %+v", snapshot)
	}
	return snapshot
}

func TestInstallProcessLoadingDuringBlockedStartAndAfterStop(t *testing.T) {
	requireInstallResponder(t)

	healthCheckStarted := make(chan struct{})
	releaseHealthCheck := make(chan struct{})
	var releaseOnce sync.Once
	var startOnce sync.Once
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() { close(healthCheckStarted) })
		<-releaseHealthCheck
		http.Error(w, "synthetic load still blocked", http.StatusServiceUnavailable)
	}))
	t.Cleanup(func() { mock.Close() })

	baseline := installActivitySnapshot(t)
	cmd, _ := simpleResponderCmd(t, "-silent")
	p := newProcessCommand(t, config.ModelConfig{
		Cmd:                cmd,
		Proxy:              mock.URL,
		CheckEndpoint:      "/health",
		HealthCheckTimeout: 30,
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseHealthCheck) })
		_ = p.Stop(testStopTimeout)
	})

	runErr := make(chan error, 1)
	go func() { runErr <- p.Run(testStartTimeout) }()
	select {
	case <-healthCheckStarted:
	case <-time.After(testStartTimeout):
		t.Fatal("synthetic health check did not block")
	}

	snapshot := activity.Process().Snapshot()
	if got := installActivityValue(t, snapshot.Loading); got != 1 {
		t.Fatalf("loading while start is blocked = %d, want 1", got)
	}
	if got := installActivityValue(t, snapshot.WorkStarted); got != *baseline.WorkStarted+1 {
		t.Fatalf("workStarted while start is blocked = %d, want %d", got, *baseline.WorkStarted+1)
	}

	stopDone := make(chan error, 1)
	go func() { stopDone <- p.Stop(testStopTimeout) }()
	// The HTTP client may abandon this request as soon as the start context is
	// cancelled. Release the synthetic server before waiting for cleanup so a
	// fatal assertion cannot leave httptest.Server.Close blocked on its handler.
	releaseOnce.Do(func() { close(releaseHealthCheck) })
	if err := <-stopDone; err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := <-runErr; !errors.Is(err, ErrStartAborted) {
		t.Fatalf("Run error = %v, want ErrStartAborted", err)
	}
	snapshot = activity.Process().Snapshot()
	if got := installActivityValue(t, snapshot.Loading); got != 0 {
		t.Fatalf("loading after child reaping = %d, want 0", got)
	}
}

func TestInstallProcessCanceledCallerLeavesActualStartAndRestartSequence(t *testing.T) {
	requireInstallResponder(t)

	healthCheckStarted := make(chan struct{})
	releaseHealthCheck := make(chan struct{})
	var releaseOnce sync.Once
	var startOnce sync.Once
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() {
			close(healthCheckStarted)
			<-releaseHealthCheck
		})
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(func() { mock.Close() })

	baseline := installActivitySnapshot(t)
	cmd, _ := simpleResponderCmd(t, "-silent")
	p := newProcessCommand(t, config.ModelConfig{
		Cmd:                cmd,
		Proxy:              mock.URL,
		CheckEndpoint:      "/health",
		HealthCheckTimeout: 30,
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseHealthCheck) })
		_ = p.Stop(testStopTimeout)
	})

	callerCtx, cancelCaller := context.WithCancel(context.Background())
	ensureErr := make(chan error, 1)
	go func() { ensureErr <- p.EnsureReady(callerCtx, testStartTimeout) }()
	select {
	case <-healthCheckStarted:
	case <-time.After(testStartTimeout):
		t.Fatal("synthetic health check did not block")
	}
	if got := installActivityValue(t, activity.Process().Snapshot().Loading); got != 1 {
		t.Fatalf("loading before caller cancellation = %d, want 1", got)
	}

	cancelCaller()
	if err := <-ensureErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("EnsureReady error = %v, want context.Canceled", err)
	}
	if got := installActivityValue(t, activity.Process().Snapshot().Loading); got != 1 {
		t.Fatalf("loading after caller cancellation = %d, want 1", got)
	}

	releaseOnce.Do(func() { close(releaseHealthCheck) })
	readyCtx, cancelReady := context.WithTimeout(context.Background(), testStartTimeout)
	if err := p.WaitReady(readyCtx); err != nil {
		cancelReady()
		t.Fatalf("WaitReady after caller cancellation: %v", err)
	}
	cancelReady()
	snapshot := activity.Process().Snapshot()
	if got := installActivityValue(t, snapshot.Loading); got != 0 {
		t.Fatalf("loading after actual start completed = %d, want 0", got)
	}
	if got := installActivityValue(t, snapshot.WorkStarted); got != *baseline.WorkStarted+1 {
		t.Fatalf("workStarted after first start = %d, want %d", got, *baseline.WorkStarted+1)
	}

	if err := p.Stop(testStopTimeout); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := p.EnsureReady(context.Background(), testStartTimeout); err != nil {
		t.Fatalf("second EnsureReady: %v", err)
	}
	snapshot = activity.Process().Snapshot()
	if got := installActivityValue(t, snapshot.WorkStarted); got != *baseline.WorkStarted+3 {
		t.Fatalf("workStarted after start, stop, start = %d, want %d", got, *baseline.WorkStarted+3)
	}
}

func TestInstallProcessServeHTTPActivityHeldThroughHandlerReturn(t *testing.T) {
	requireInstallResponder(t)

	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	var releaseOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestStarted)
		<-releaseRequest
		_, _ = io.WriteString(w, "synthetic response")
	}))
	t.Cleanup(func() { upstream.Close() })

	baseline := installActivitySnapshot(t)
	cmd, _ := simpleResponderCmd(t, "-silent")
	p := newProcessCommand(t, config.ModelConfig{
		Cmd:           cmd,
		Proxy:         upstream.URL,
		CheckEndpoint: "none",
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseRequest) })
		_ = p.Stop(testStopTimeout)
	})

	runErr := runAsync(t, p)
	if got := installActivityValue(t, activity.Process().Snapshot().WorkStarted); got != *baseline.WorkStarted+1 {
		t.Fatalf("workStarted after ready = %d, want %d", got, *baseline.WorkStarted+1)
	}

	response := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		p.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/blocked", nil))
	}()
	select {
	case <-requestStarted:
	case <-time.After(testStartTimeout):
		t.Fatal("synthetic upstream request did not start")
	}

	if got := installActivityValue(t, activity.Process().Snapshot().Active); got != 1 {
		t.Fatalf("active while handler is blocked = %d, want 1", got)
	}
	releaseOnce.Do(func() { close(releaseRequest) })
	select {
	case <-requestDone:
	case <-time.After(testReturnTimeout):
		t.Fatal("ServeHTTP did not return")
	}
	if response.Code != http.StatusOK || response.Body.String() != "synthetic response" {
		t.Fatalf("unexpected proxy response: code=%d body=%q", response.Code, response.Body.String())
	}
	if got := installActivityValue(t, activity.Process().Snapshot().Active); got != 0 {
		t.Fatalf("active after handler return = %d, want 0", got)
	}

	if err := p.Stop(testStopTimeout); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run after Stop: %v", err)
		}
	case <-time.After(testReturnTimeout):
		t.Fatal("Run did not return after Stop")
	}
}
