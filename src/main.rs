mod cli;
mod shared;
mod tui;

use clap::Parser;
use cli::{Cli, CliHandler};
use color_eyre::Result;
use tui::App;

fn main() -> Result<()> {
    color_eyre::install()?;

    let cli = Cli::parse();

    if cli.interactive || cli.command.is_none() {
        run_tui()
    } else {
        run_cli(cli)
    }
}

fn run_tui() -> Result<()> {
    let terminal = ratatui::init();
    let result = App::new().run(terminal);
    ratatui::restore();
    result
}

fn run_cli(cli: Cli) -> Result<()> {
    let mut handler = CliHandler::new();
    handler.run(cli)
}
