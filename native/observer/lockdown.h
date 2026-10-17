#ifndef GI_OBSERVER_LOCKDOWN_H
#define GI_OBSERVER_LOCKDOWN_H
/* Linux-only, irreversible. Caller must exit on failure; never continue unconfined. */
int gi_observer_lockdown(void);
#endif
