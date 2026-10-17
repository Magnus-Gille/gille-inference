package activity

import (
	"encoding/json"
	"sync"
	"testing"
)

func count(value *uint64) uint64 {
	if value == nil {
		return 0
	}
	return *value
}

func TestStagesFinishAndSnapshotValuesDoNotAlias(t *testing.T) {
	tracker := New()
	queued := tracker.Begin(Queued)
	active := tracker.Begin(Active)
	loading := tracker.Begin(Loading)
	if queued == nil || active == nil || loading == nil {
		t.Fatal("expected all handles to be live")
	}

	queued.Transition(Active)
	active.Transition(Loading)
	loading.Transition(Queued)
	snapshot := tracker.Snapshot()
	if count(snapshot.Active) != 1 || count(snapshot.Queued) != 1 || count(snapshot.Loading) != 1 || count(snapshot.WorkStarted) != 3 {
		t.Fatalf("unexpected transitioned snapshot: %+v", snapshot)
	}
	if got, want := mustJSON(t, snapshot), `{"active":1,"queued":1,"loading":1,"workStarted":3}`; got != want {
		t.Fatalf("snapshot JSON = %s, want %s", got, want)
	}
	*snapshot.Active = 99
	if got := count(tracker.Snapshot().Active); got != 1 {
		t.Fatalf("snapshot pointer aliases tracker state: got %d", got)
	}

	queued.Finish()
	active.Finish()
	loading.Finish()
	final := tracker.Snapshot()
	if count(final.Active) != 0 || count(final.Queued) != 0 || count(final.Loading) != 0 || count(final.WorkStarted) != 3 {
		t.Fatalf("unexpected final snapshot: %+v", final)
	}
}

func TestFinishHandlesCanceledAndFailedWork(t *testing.T) {
	tracker := New()
	canceled := tracker.Begin(Queued)
	failed := tracker.Begin(Loading)
	canceled.Finish()
	failed.Finish()
	snapshot := tracker.Snapshot()
	if count(snapshot.Active) != 0 || count(snapshot.Queued) != 0 || count(snapshot.Loading) != 0 || count(snapshot.WorkStarted) != 2 {
		t.Fatalf("finish did not clear canceled/failed work: %+v", snapshot)
	}
}

func TestFaultLatchesAndOperationsBecomeInert(t *testing.T) {
	tracker := New()
	handle := tracker.Begin(Queued)
	if handle == nil {
		t.Fatal("expected handle")
	}
	handle.Transition(Stage("invalid"))
	if snapshot := tracker.Snapshot(); snapshot.Active != nil || snapshot.Queued != nil || snapshot.Loading != nil || snapshot.WorkStarted != nil {
		t.Fatalf("fault snapshot must be all null: %+v", snapshot)
	}
	if got := tracker.Begin(Active); got != nil {
		t.Fatal("faulted tracker returned a live handle")
	}
	handle.Finish()
	(*Handle)(nil).Transition(Queued)
	(*Handle)(nil).Finish()
}

func TestZeroTrackerLatchesUnknownBeforeReportingIdle(t *testing.T) {
	var tracker Tracker
	snapshot := tracker.Snapshot()
	if snapshot.Active != nil || snapshot.Queued != nil || snapshot.Loading != nil || snapshot.WorkStarted != nil {
		t.Fatalf("zero tracker must report unknown: %+v", snapshot)
	}
	if tracker.Begin(Queued) != nil {
		t.Fatal("zero tracker returned a live handle")
	}
	if snapshot := tracker.Snapshot(); snapshot.Active != nil || snapshot.WorkStarted != nil {
		t.Fatalf("zero tracker did not remain unknown: %+v", snapshot)
	}

	var other Tracker
	(&Handle{tracker: &other, record: &record{owner: &other, stage: Queued, live: true}}).Transition(Active)
	if snapshot := other.Snapshot(); snapshot.Active != nil || snapshot.WorkStarted != nil {
		t.Fatalf("zero tracker transition did not latch unknown: %+v", snapshot)
	}
}

func TestDuplicateFinishAndForeignHandleLatchUnknown(t *testing.T) {
	tracker := New()
	handle := tracker.Begin(Active)
	handle.Finish()
	handle.Finish()
	if snapshot := tracker.Snapshot(); snapshot.Active != nil || snapshot.WorkStarted != nil {
		t.Fatalf("duplicate finish must latch unknown: %+v", snapshot)
	}

	owner, err := newWithCaps(2, 2)
	if err != nil {
		t.Fatal(err)
	}
	foreignOwner, err := newWithCaps(2, 2)
	if err != nil {
		t.Fatal(err)
	}
	foreign := owner.Begin(Queued)
	(&Handle{tracker: foreignOwner, record: foreign.record}).Finish()
	if snapshot := foreignOwner.Snapshot(); snapshot.Queued != nil {
		t.Fatalf("foreign finish must latch the receiving tracker: %+v", snapshot)
	}
	if snapshot := owner.Snapshot(); snapshot.Queued == nil || count(snapshot.Queued) != 1 {
		t.Fatalf("foreign use corrupted original tracker: %+v", snapshot)
	}
}

func TestCapacityAndSequenceFaults(t *testing.T) {
	tracker, err := newWithCaps(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	first := tracker.Begin(Queued)
	if first == nil || tracker.Begin(Active) != nil {
		t.Fatal("record capacity should fault on the second live begin")
	}
	if snapshot := tracker.Snapshot(); snapshot.Queued != nil || snapshot.WorkStarted != nil {
		t.Fatalf("record capacity fault not latched: %+v", snapshot)
	}

	tracker, err = newWithCaps(1, 1)
	if err != nil {
		t.Fatal(err)
	}
	first = tracker.Begin(Queued)
	first.Finish()
	if tracker.Begin(Active) != nil {
		t.Fatal("sequence capacity should fault after one start")
	}
	if snapshot := tracker.Snapshot(); snapshot.WorkStarted != nil {
		t.Fatalf("sequence fault not latched: %+v", snapshot)
	}

	for _, caps := range [][2]uint64{{0, 1}, {4097, 1}, {1, 0}, {1, defaultMaxSequence + 1}} {
		if _, err := newWithCaps(caps[0], caps[1]); err == nil {
			t.Fatalf("invalid caps %v were accepted", caps)
		}
	}
}

func TestConcurrentTransitionsSnapshotsAndFinishes(t *testing.T) {
	tracker, err := newWithCaps(128, 128)
	if err != nil {
		t.Fatal(err)
	}
	const workers = 64
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			handle := tracker.Begin(Queued)
			if handle == nil {
				return
			}
			handle.Transition(Active)
			handle.Transition(Loading)
			handle.Finish()
		}()
	}
	close(start)
	for i := 0; i < 128; i++ {
		snapshot := tracker.Snapshot()
		if snapshot.WorkStarted != nil && count(snapshot.WorkStarted) > workers {
			t.Fatalf("workStarted exceeded workers: %+v", snapshot)
		}
	}
	wg.Wait()
	snapshot := tracker.Snapshot()
	if snapshot.Active == nil || snapshot.Queued == nil || snapshot.Loading == nil || snapshot.WorkStarted == nil {
		t.Fatalf("concurrent operations latched an unexpected fault: %+v", snapshot)
	}
	if count(snapshot.Active) != 0 || count(snapshot.Queued) != 0 || count(snapshot.Loading) != 0 || count(snapshot.WorkStarted) != workers {
		t.Fatalf("unexpected concurrent final snapshot: %+v", snapshot)
	}
}

func mustJSON(t *testing.T, snapshot Snapshot) string {
	t.Helper()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
