use crate::shared::SharedLogic;
use clap::{Parser, Subcommand};
use color_eyre::Result;

#[derive(Parser, Debug)]
#[command(name = "devver-cli")]
#[command(version)]
#[command(about = "Ultra-fast deployments and visual feedback for Devver", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    #[arg(short, long)]
    pub interactive: bool,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    Hello {
        name: Option<String>,
    },
    Count,
    Echo {
        #[arg(trailing_var_arg = true)]
        text: Vec<String>,
    },
}

pub struct CliHandler {
    shared: SharedLogic,
}

impl CliHandler {
    pub fn new() -> Self {
        Self {
            shared: SharedLogic::new(),
        }
    }

    pub fn run(&mut self, cli: Cli) -> Result<()> {
        match cli.command {
            Some(cmd) => {
                let output = self.handle_command(cmd)?;
                println!("{}", output);
            }
            None => {
                println!("No command provided. Use --help or --interactive");
            }
        }
        Ok(())
    }

    fn handle_command(&mut self, cmd: Commands) -> Result<String> {
        match cmd {
            Commands::Hello { name } => Ok(self.shared.process_hello(name.as_deref())),
            Commands::Count => Ok(self.shared.process_count()),
            Commands::Echo { text } => Ok(self.shared.process_echo(&text)),
        }
    }
}
