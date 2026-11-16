// rust-sdk's own src/agent-client-protocol-test/src/bin/testy.rs, v1 only: Cargo builds no dependency's binaries.
use agent_client_protocol::ConnectTo;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();
    agent_client_protocol_test::testy::v1::Testy::new()
        .connect_to(agent_client_protocol::Stdio::new())
        .await?;
    Ok(())
}
