//! In-memory token-bucket rate limiter (per client IP). No external deps.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct RateLimiter {
    map: Mutex<HashMap<IpAddr, Bucket>>,
    /// tokens added per second
    rate: f64,
    /// bucket capacity
    burst: f64,
}

impl RateLimiter {
    /// `per_sec` tokens per second, `burst` capacity.
    pub fn per_second(per_sec: f64, burst: f64) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            rate: per_sec,
            burst,
        }
    }

    /// `count` events per window (e.g. 5 sandbox creations per hour).
    #[cfg(test)]
    pub fn per_window(count: u32, window: Duration) -> Self {
        Self::per_second(count as f64 / window.as_secs_f64(), count as f64)
    }

    /// Consume one token; false = rate limited.
    pub fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.map.lock().unwrap();
        // bound memory: drop idle buckets when the map grows large
        if map.len() > 10_000 {
            let cutoff = Instant::now() - Duration::from_secs(600);
            map.retain(|_, b| b.last > cutoff);
        }
        if map.len() >= 10_000 && !map.contains_key(&ip) {
            return false;
        }
        let now = Instant::now();
        let b = map.entry(ip).or_insert(Bucket {
            tokens: self.burst,
            last: now,
        });
        b.tokens =
            (b.tokens + self.rate * now.duration_since(b.last).as_secs_f64()).min(self.burst);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn bucket_limits() {
        let rl = RateLimiter::per_second(2.0, 4.0);
        let ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
        for _ in 0..4 {
            assert!(rl.check(ip));
        }
        assert!(!rl.check(ip));
        // a different IP is unaffected
        assert!(rl.check(IpAddr::V4(Ipv4Addr::new(9, 9, 9, 9))));
    }

    #[test]
    fn window_limits() {
        let rl = RateLimiter::per_window(2, Duration::from_secs(3600));
        let ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
        assert!(rl.check(ip));
        assert!(rl.check(ip));
        assert!(!rl.check(ip));
    }
}
