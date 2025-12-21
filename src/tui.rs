use color_eyre::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Wrap},
};
use crate::shared::{SharedLogic, CommandHandler};

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Mode {
    #[default]
    Normal,
    Command,
}

#[derive(Debug, Default)]
pub struct App {
    pub mode: Mode,
    pub running: bool,
    pub command_input: String,
    pub output_log: Vec<String>,
    pub shared: SharedLogic,
}

impl App {
    pub fn new() -> Self {
        let mut app = Self {
            mode: Mode::Normal,
            running: true,
            command_input: String::new(),
            output_log: Vec::new(),
            shared: SharedLogic::new(),
        };
        app.log("Welcome! Press ':' for command mode, 'q' to quit.");
        app.log("Commands: hello [name], count, echo <text>, help");
        app
    }

    pub fn run(mut self, mut terminal: DefaultTerminal) -> Result<()> {
        while self.running {
            terminal.draw(|frame| self.render(frame))?;
            self.handle_events()?;
        }
        Ok(())
    }

    fn render(&mut self, frame: &mut Frame) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(0), Constraint::Length(3)])
            .split(frame.area());

        self.render_main(frame, chunks[0]);
        self.render_status_bar(frame, chunks[1]);
    }

    fn render_main(&self, frame: &mut Frame, area: Rect) {
        let title = match self.mode {
            Mode::Normal => "Normal Mode",
            Mode::Command => "Command Mode",
        };

        let title_style = match self.mode {
            Mode::Normal => Style::default().fg(Color::Cyan),
            Mode::Command => Style::default().fg(Color::Yellow),
        };

        let inner_chunks = if self.mode == Mode::Command {
            Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(0), Constraint::Length(3)])
                .split(area)
        } else {
            Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(0)])
                .split(area)
        };

        let visible_lines = inner_chunks[0].height.saturating_sub(2) as usize;
        let output_text: Vec<Line> = self.output_log
            .iter()
            .rev()
            .take(visible_lines)
            .rev()
            .map(|line| Line::from(line.as_str()))
            .collect();

        let output = Paragraph::new(output_text)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .title(Line::from(title).style(title_style.add_modifier(Modifier::BOLD)))
            )
            .wrap(Wrap { trim: true });

        frame.render_widget(output, inner_chunks[0]);

        if self.mode == Mode::Command {
            let input = Paragraph::new(format!(":{}", self.command_input))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .title("Command")
                );
            frame.render_widget(input, inner_chunks[1]);
        }
    }

    fn render_status_bar(&self, frame: &mut Frame, area: Rect) {
        let (mode_text, mode_color) = match self.mode {
            Mode::Normal => ("NORMAL", Color::Green),
            Mode::Command => ("COMMAND", Color::Yellow),
        };

        let status = vec![
            Span::styled(
                format!(" {} ", mode_text),
                Style::default().bg(mode_color).fg(Color::Black).add_modifier(Modifier::BOLD),
            ),
            Span::raw(" | "),
            Span::styled(":", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("command "),
            Span::styled("q", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(":quit"),
        ];

        let paragraph = Paragraph::new(Line::from(status))
            .block(Block::default().borders(Borders::ALL).border_type(BorderType::Rounded));

        frame.render_widget(paragraph, area);
    }

    fn handle_events(&mut self) -> Result<()> {
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                self.handle_key(key);
            }
        }
        Ok(())
    }

    fn handle_key(&mut self, key: KeyEvent) {
        match self.mode {
            Mode::Normal => self.handle_normal_keys(key),
            Mode::Command => self.handle_command_keys(key),
        }
    }

    fn handle_normal_keys(&mut self, key: KeyEvent) {
        match (key.modifiers, key.code) {
            (_, KeyCode::Char('q')) | (KeyModifiers::CONTROL, KeyCode::Char('c')) => {
                self.running = false;
            }
            (_, KeyCode::Char(':')) => {
                self.mode = Mode::Command;
                self.command_input.clear();
            }
            _ => {}
        }
    }

    fn handle_command_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => self.execute_command(),
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.command_input.clear();
            }
            KeyCode::Backspace => {
                self.command_input.pop();
            }
            KeyCode::Char(c) => {
                self.command_input.push(c);
            }
            _ => {}
        }
    }

    fn execute_command(&mut self) {
        let input = self.command_input.trim().to_string();
        if input.is_empty() {
            self.mode = Mode::Normal;
            return;
        }

        let parts: Vec<&str> = input.split_whitespace().collect();
        let cmd = parts[0];
        let args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();

        self.log(&format!("> {}", input));

        match self.shared.handle_command(cmd, args) {
            Ok(output) => self.log(&output),
            Err(e) => self.log(&format!("Error: {}", e)),
        }

        self.mode = Mode::Normal;
        self.command_input.clear();
    }

    fn log(&mut self, msg: &str) {
        self.output_log.push(msg.to_string());
        if self.output_log.len() > 500 {
            self.output_log.remove(0);
        }
    }
}
