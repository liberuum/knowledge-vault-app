//! The engine's process tree. The engine spawns workers of its own (the workflow runtime's piece
//! workers, the conversion helper). Killing only the engine leaves them orphaned; under an AppImage
//! they then crash with SIGBUS the moment the shell exits and the image is unmounted. The shell
//! therefore records the whole tree while it waits for the engine to stop, and ends what is left.

use std::collections::{BTreeSet, HashMap};
use std::process::Command;
use std::time::{Duration, Instant};

/// Every descendant of `root` in a (pid, ppid) table, children before grandchildren.
pub fn descendants(root: u32, table: &[(u32, u32)]) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in table {
        children.entry(ppid).or_default().push(pid);
    }
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(p) = queue.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                if k != root && !out.contains(&k) {
                    out.push(k);
                    queue.push(k);
                }
            }
        }
    }
    out
}

/// Parse `ps -A -o pid= -o ppid=` output.
pub fn parse_ps(text: &str) -> Vec<(u32, u32)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect()
}

#[cfg(unix)]
fn process_table() -> Vec<(u32, u32)> {
    Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .output()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn signal(pid: u32, sig: &str) {
    let _ = Command::new("kill").args([sig, &pid.to_string()]).status();
}

/// The tree under `root` as it is now, added to what was already known.
#[derive(Default)]
pub struct Tree {
    known: BTreeSet<u32>,
}

impl Tree {
    #[cfg(unix)]
    pub fn record(&mut self, root: u32) {
        self.known.extend(descendants(root, &process_table()));
    }
    #[cfg(not(unix))]
    pub fn record(&mut self, _root: u32) {}

    /// End every recorded descendant still alive: TERM, a short grace, then KILL.
    #[cfg(unix)]
    pub fn end(&self) {
        let left: Vec<u32> = self.known.iter().copied().filter(|&p| alive(p)).collect();
        if left.is_empty() {
            return;
        }
        eprintln!(
            "[shell] ending {} engine worker(s) left behind: {:?}",
            left.len(),
            left
        );
        for &p in &left {
            signal(p, "-TERM");
        }
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until && left.iter().any(|&p| alive(p)) {
            std::thread::sleep(Duration::from_millis(100));
        }
        for &p in &left {
            if alive(p) {
                signal(p, "-KILL");
            }
        }
    }
    #[cfg(not(unix))]
    pub fn end(&self) {}
}

/// Windows: end the engine and everything it started in one call.
#[cfg(windows)]
pub fn end_tree_windows(root: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &root.to_string(), "/T", "/F"])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_children_and_grandchildren_but_not_siblings() {
        // 1 → engine 100 → workers 101, 102; 102 → 103; an unrelated 200 under 1.
        let table = [(100, 1), (101, 100), (102, 100), (103, 102), (200, 1)];
        let mut d = descendants(100, &table);
        d.sort();
        assert_eq!(d, vec![101, 102, 103]);
        assert!(descendants(200, &table).is_empty());
    }

    #[test]
    fn survives_a_cycle_in_a_racy_table() {
        let table = [(101, 100), (100, 101)];
        assert_eq!(descendants(100, &table), vec![101]);
    }

    // A real process tree on this machine — the same `ps` and `kill` the shell uses (Linux and macOS).
    #[cfg(unix)]
    #[test]
    fn records_and_ends_a_real_tree() {
        let mut parent = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & sleep 30 & wait"])
            .spawn()
            .expect("sh");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mut tree = Tree::default();
        tree.record(parent.id());
        let recorded: Vec<u32> = tree.known.iter().copied().collect();
        assert_eq!(recorded.len(), 2, "both sleeps recorded: {recorded:?}");
        let _ = parent.kill();
        let _ = parent.wait();
        tree.end();
        assert!(recorded.iter().all(|&p| !alive(p)), "a recorded child survived");
    }

    #[test]
    fn parses_ps_output_and_skips_junk() {
        assert_eq!(
            parse_ps("  100     1\n  101   100\nPID PPID\n\n"),
            vec![(100, 1), (101, 100)]
        );
    }
}
