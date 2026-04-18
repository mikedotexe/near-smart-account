use near_sdk::{env, ext_contract, near, AccountId, Gas, PanicOnDefault, PromiseError};

const GAS_ECHO: Gas = Gas::from_tgas(5);
const GAS_CALLBACK: Gas = Gas::from_tgas(5);

#[ext_contract(ext_echo)]
#[allow(dead_code)]
trait ExtEcho {
    fn echo(&self, n: u32) -> u32;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WildRouter {
    pub last_started: Option<u32>,
    pub last_finished: Option<u32>,
}

#[near]
impl WildRouter {
    #[init]
    pub fn new() -> Self {
        Self {
            last_started: None,
            last_finished: None,
        }
    }

    /// Starts real downstream async work but returns immediately instead of
    /// returning that promise chain to the caller.
    pub fn route_echo_fire_and_forget(&mut self, callee: AccountId, n: u32) -> String {
        self.last_started = Some(n);
        self.last_finished = None;

        ext_echo::ext(callee)
            .with_static_gas(GAS_ECHO)
            .echo(n)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_echo_finished(),
            )
            .detach();

        format!("started:{n}")
    }

    #[private]
    pub fn on_echo_finished(
        &mut self,
        #[callback_result] result: Result<u32, PromiseError>,
    ) -> Option<u32> {
        match result {
            Ok(n) => {
                self.last_finished = Some(n);
                Some(n)
            }
            Err(_) => {
                env::log_str("route_echo_fire_and_forget downstream echo failed");
                self.last_finished = None;
                None
            }
        }
    }

    pub fn get_last_started(&self) -> Option<u32> {
        self.last_started
    }

    pub fn get_last_finished(&self) -> Option<u32> {
        self.last_finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fire_and_forget_start_clears_finished_state() {
        let mut c = WildRouter::new();
        c.last_finished = Some(99);

        let started = c.route_echo_fire_and_forget("echo.near".parse().unwrap(), 7);

        assert_eq!(started, "started:7");
        assert_eq!(c.get_last_started(), Some(7));
        assert_eq!(c.get_last_finished(), None);
    }

    #[test]
    fn callback_marks_finished_state() {
        let mut c = WildRouter::new();
        assert_eq!(c.on_echo_finished(Ok(42)), Some(42));
        assert_eq!(c.get_last_finished(), Some(42));
    }
}
