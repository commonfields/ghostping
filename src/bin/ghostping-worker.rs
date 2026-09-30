//! Stateless hosted observation worker.
//! Reads one `ghostping-worker-job-v1` JSON from stdin, writes one
//! `ghostping-worker-result-v1` JSON to stdout. Stderr is diagnostics only.
//! Never touches SQLite or Postgres; knows nothing of accounts/businesses.
use ghostping::worker_contract::{execute_job, WorkerJob, JOB_CONTRACT_VERSION};
use std::io::Read;

fn main() {
    let mut buf = String::new();
    if (std::io::stdin().read_to_string(&mut buf).is_err()) || buf.trim().is_empty() {
        eprintln!("ghostping-worker: empty stdin; expected job-v1 JSON");
        std::process::exit(2);
    }
    let job: WorkerJob = match serde_json::from_str(&buf) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("ghostping-worker: invalid job JSON: {e}");
            std::process::exit(2);
        }
    };
    if job.contract_version != JOB_CONTRACT_VERSION {
        // Still emit a versioned failure result so the Effect worker can
        // record a typed WORKER_CONTRACT_MISMATCH instead of guessing.
        let result = execute_job(&job);
        println!("{}", serde_json::to_string(&result).unwrap_or_default());
        std::process::exit(0);
    }
    let result = execute_job(&job);
    match serde_json::to_string(&result) {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("ghostping-worker: result serialization failed: {e}");
            std::process::exit(1);
        }
    }
}
