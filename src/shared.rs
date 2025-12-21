use color_eyre::Result;

#[derive(Debug, Default)]
pub struct AppState {
    pub counter: u32,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn increment(&mut self) {
        self.counter += 1;
    }
}

pub trait CommandHandler {
    fn handle_command(&mut self, command: &str, args: Vec<String>) -> Result<String>;
}

#[derive(Debug, Default)]
pub struct SharedLogic {
    pub state: AppState,
}

impl SharedLogic {
    pub fn new() -> Self {
        Self {
            state: AppState::new(),
        }
    }

    pub fn process_hello(&self, name: Option<&str>) -> String {
        match name {
            Some(n) => format!("Hello, {}!", n),
            None => "Hello, World!".to_string(),
        }
    }

    pub fn process_count(&mut self) -> String {
        self.state.increment();
        format!("Counter is now: {}", self.state.counter)
    }

    pub fn process_echo(&self, args: &[String]) -> String {
        if args.is_empty() {
            "(empty)".to_string()
        } else {
            args.join(" ")
        }
    }
}

impl CommandHandler for SharedLogic {
    fn handle_command(&mut self, command: &str, args: Vec<String>) -> Result<String> {
        match command {
            "hello" => Ok(self.process_hello(args.first().map(|s| s.as_str()))),
            "count" => Ok(self.process_count()),
            "echo" => Ok(self.process_echo(&args)),
            "help" => Ok("Available commands: hello [name], count, echo <text>, help".to_string()),
            _ => Ok(format!(
                "Unknown command: '{}'. Type 'help' for available commands.",
                command
            )),
        }
    }
}
