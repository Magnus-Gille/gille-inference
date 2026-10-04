import contextlib, importlib.util, os, tempfile, time, unittest
from pathlib import Path
from unittest import mock
spec=importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1]/'scripts/m5-build-worker.py')
w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
class CleanupPolicy(unittest.TestCase):
 def fixture(self, days):
  tmp=tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
  state=Path(tmp.name); tree=state/'repos'/('a'*64)/'worktrees'/('b'*64)
  for part in ['source','target']: (tree/part).mkdir(parents=True)
  (tree/'source'/'source.rs').write_text('source'); (tree/'target'/'binary').write_text('large rebuildable output')
  stamp=tree/'.last-used'; stamp.touch(); old=time.time()-days*86400; os.utime(stamp,(old,old))
  return state,tree
 def test_idle_targets_reclaimed_after_seven_days_source_retained(self):
  state,tree=self.fixture(8)
  w.cleanup_stale(state)
  self.assertFalse((tree/'target').exists()); self.assertTrue((tree/'source'/'source.rs').exists())
 def test_recent_worktree_preserved(self):
  state,tree=self.fixture(6); w.cleanup_stale(state)
  self.assertTrue((tree/'target'/'binary').exists())
 def test_whole_idle_tree_reclaimed_after_fourteen_days(self):
  state,tree=self.fixture(15); w.cleanup_stale(state); self.assertFalse(tree.exists())
 def test_busy_worktree_never_evicted(self):
  state,tree=self.fixture(15)
  with mock.patch.object(w,'job_locks',side_effect=w.BuildError('This worktree already has a build; retry after it finishes.')):
   w.cleanup_stale(state)
  self.assertTrue((tree/'target'/'binary').exists())
 def test_missing_or_future_stamp_never_evicted(self):
  state,tree=self.fixture(-1); w.cleanup_stale(state); self.assertTrue((tree/'target').exists())
  (tree/'.last-used').unlink(); w.cleanup_stale(state); self.assertTrue((tree/'target').exists())
if __name__=='__main__': unittest.main()
