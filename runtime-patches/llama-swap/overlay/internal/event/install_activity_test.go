package event

import (
	"sync"
	"testing"
	"time"

	activity "github.com/mostlygeek/llama-swap/internal/installactivity"
)

type installActivityEvent struct {
	id uint32
}

func (installActivityEvent) Type() uint32 { return 0x1a11 }

func TestInstallActivityTracksQueuedEventsUntilCallbacksFinish(t *testing.T) {
	dispatcher := NewDispatcherConfig(1)
	defer dispatcher.Close()

	started := make(chan uint32, 2)
	releaseOne := make(chan struct{})
	releaseTwo := make(chan struct{})
	var releaseOneOnce sync.Once
	var releaseTwoOnce sync.Once
	finishOne := func() { releaseOneOnce.Do(func() { close(releaseOne) }) }
	finishTwo := func() { releaseTwoOnce.Do(func() { close(releaseTwo) }) }
	defer finishOne()
	defer finishTwo()
	callbackTwoReturned := make(chan struct{})
	cancel := Subscribe(dispatcher, func(event installActivityEvent) {
		started <- event.id
		switch event.id {
		case 1:
			<-releaseOne
		case 2:
			<-releaseTwo
			close(callbackTwoReturned)
		}
	})
	defer cancel()

	baseline := installActivityQueued(t)
	Publish(dispatcher, installActivityEvent{id: 1})
	waitInstallEvent(t, started, 1)

	// The first callback owns the consumer. The second event is accepted into
	// its queue and Publish returns while the second callback remains blocked.
	Publish(dispatcher, installActivityEvent{id: 2})
	finishOne()
	waitInstallEvent(t, started, 2)
	if got, want := installActivityQueued(t), baseline+1; got != want {
		t.Fatalf("queued activity after second publish = %d, want baseline + 1 = %d", got, want)
	}

	finishTwo()
	waitInstallSignal(t, callbackTwoReturned)
	waitInstallQueued(t, baseline)
}

func installActivityQueued(t *testing.T) uint64 {
	t.Helper()
	snapshot := activity.Process().Snapshot()
	if snapshot.Queued == nil {
		t.Fatal("activity tracker reported unknown queued count")
	}
	return *snapshot.Queued
}

func waitInstallEvent(t *testing.T, events <-chan uint32, want uint32) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case got := <-events:
		if got != want {
			t.Fatalf("callback event = %d, want %d", got, want)
		}
	case <-timer.C:
		t.Fatalf("timed out waiting for callback event %d", want)
	}
}

func waitInstallSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-signal:
	case <-timer.C:
		t.Fatal("timed out waiting for callback completion")
	}
}

func waitInstallQueued(t *testing.T, want uint64) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer timer.Stop()
	defer ticker.Stop()
	for {
		if got := installActivityQueued(t); got == want {
			return
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatalf("timed out waiting for queued activity %d", want)
		}
	}
}
