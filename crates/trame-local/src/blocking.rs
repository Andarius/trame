use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    sync::{Notify, Semaphore},
    task::JoinHandle,
};

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static IDLE: Notify = Notify::const_new();
static CAPACITY: Semaphore = Semaphore::const_new(16);

struct AbortOnDrop<T>(JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Active;

impl Drop for Active {
    fn drop(&mut self) {
        if ACTIVE.fetch_sub(1, Ordering::SeqCst) == 1 {
            IDLE.notify_waiters();
        }
    }
}

/// Track blocking work even if its async waiter is cancelled.
pub fn spawn<F, T>(work: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    let guard = Active;
    tokio::spawn(async move {
        let permit = CAPACITY
            .acquire()
            .await
            .expect("blocking capacity remains open");
        let mut task = AbortOnDrop(tokio::task::spawn_blocking(move || {
            let (_guard, _permit) = (guard, permit);
            work()
        }));
        match (&mut task.0).await {
            Ok(value) => value,
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    })
}

/// Wait for registered work after its callers have stopped queuing it.
pub async fn drain() {
    loop {
        let notified = IDLE.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if ACTIVE.load(Ordering::SeqCst) == 0 {
            return;
        }
        notified.await;
    }
}
