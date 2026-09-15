//! Transport-only adapters. Both call the same car producer, queue and controls.
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Semaphore};
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    Message,
};
use wtransport::{RecvStream, SendStream};
pub(crate) struct Outgoing {
    id: u32,
    bytes: Vec<u8>,
    complete: oneshot::Sender<Result<(), String>>,
}
pub(crate) enum FleetSend {
    Quic(SendStream),
    WebSocket {
        id: u32,
        outgoing: mpsc::Sender<Outgoing>,
    },
}
pub(crate) enum FleetRecv {
    Quic(RecvStream),
    WebSocket(mpsc::Receiver<Vec<u8>>),
}
impl FleetSend {
    pub fn id(&self) -> u64 {
        match self {
            Self::Quic(s) => s.id().into_u64(),
            Self::WebSocket { id, .. } => u64::from(*id),
        }
    }
    pub async fn write_all(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Quic(s) => s.write_all(bytes).await.map_err(|e| e.to_string()),
            Self::WebSocket { id, outgoing } => {
                let (tx, rx) = oneshot::channel();
                outgoing
                    .send(Outgoing {
                        id: *id,
                        bytes: bytes.to_vec(),
                        complete: tx,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                rx.await.map_err(|e| e.to_string())?
            }
        }
    }
}
impl FleetRecv {
    pub async fn read_chunk(&mut self) -> Result<Vec<u8>, String> {
        match self {
            Self::Quic(r) => {
                let mut b = vec![0; 2048];
                let n = r
                    .read(&mut b)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("Stream closed")?;
                b.truncate(n);
                Ok(b)
            }
            Self::WebSocket(rx) => rx.recv().await.ok_or("Stream closed".into()),
        }
    }
}
fn origin_allowed(request: &Request) -> bool {
    request.uri().path() == "/fleet"
        && matches!(
            request
                .headers()
                .get("origin")
                .and_then(|h| h.to_str().ok()),
            Some("http://127.0.0.1:3100" | "http://localhost:3100")
        )
}
#[allow(clippy::result_large_err)]
fn validate(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    if origin_allowed(request) {
        Ok(response)
    } else {
        Err(tokio_tungstenite::tungstenite::http::Response::builder()
            .status(403)
            .body(Some("Origin or path not allowed".into()))
            .unwrap())
    }
}
pub async fn websocket_server(
) -> Result<impl std::future::Future<Output = ()>, Box<dyn std::error::Error>> {
    use tokio_rustls::rustls;
    let certificates = rustls_pemfile::certs(&mut std::io::BufReader::new(std::fs::File::open(
        "certs/cert.pem",
    )?))
    .collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(std::fs::File::open(
        "certs/key.pem",
    )?))?
    .ok_or("Missing key")?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:4445").await?;
    let permits = Arc::new(Semaphore::new(8));
    Ok(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = socket.set_nodelay(true);
                let Ok(Ok(tls)) =
                    tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket)).await
                else {
                    return;
                };
                let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
                    max_message_size: Some(8192),
                    max_frame_size: Some(8192),
                    ..Default::default()
                };
                let Ok(Ok(ws)) = tokio::time::timeout(
                    Duration::from_secs(5),
                    tokio_tungstenite::accept_hdr_async_with_config(tls, validate, Some(config)),
                )
                .await
                else {
                    return;
                };
                let (mut sink, mut source) = ws.split();
                let (outgoing, mut pending) = mpsc::channel::<Outgoing>(64);
                let ids = Arc::new(Mutex::new(HashSet::new()));
                let mut tasks = tokio::task::JoinSet::new();
                let mut channels = HashMap::<u32, mpsc::Sender<Vec<u8>>>::new();
                let writer = async {
                    while let Some(item) = pending.recv().await {
                        let mut bytes = Vec::with_capacity(item.bytes.len() + 5);
                        bytes.push(1);
                        bytes.extend_from_slice(&item.id.to_be_bytes());
                        bytes.extend_from_slice(&item.bytes);
                        let result = sink
                            .send(Message::Binary(bytes))
                            .await
                            .map_err(|e| e.to_string());
                        let failed = result.is_err();
                        let _ = item.complete.send(result);
                        if failed {
                            break;
                        }
                    }
                };
                let reader = async {
                    loop {
                        tokio::select! {completed=tasks.join_next(),if !tasks.is_empty()=>{if let Some(Ok(id))=completed{channels.remove(&id);}},message=source.next()=>{let Some(Ok(message))=message else{break;};match message{
                        Message::Binary(bytes) if bytes.len()>=5=>{let id=u32::from_be_bytes(bytes[1..5].try_into().unwrap());match bytes[0]{
                        1=>{if let std::collections::hash_map::Entry::Vacant(entry)=channels.entry(id){if tasks.len()>=64{break;}let(tx,rx)=mpsc::channel(8);entry.insert(tx);let outgoing=outgoing.clone();let ids=ids.clone();tasks.spawn(async move{super::car(FleetSend::WebSocket{id,outgoing},FleetRecv::WebSocket(rx),ids).await;id});}
                        if channels.get(&id).unwrap().try_send(bytes[5..].to_vec()).is_err(){break;}},
                        3=>{channels.remove(&id);},_=>break
                        }},Message::Close(_)=>break,Message::Ping(_)|Message::Pong(_)=>{},_=>break}}}
                    }
                };
                tokio::select! {_=writer=>{},_=reader=>{}}
                tasks.abort_all();
            });
        }
    })
}
pub async fn metrics() -> axum::Json<serde_json::Value> {
    // getrusage is process-local and does not inspect other applications.
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return axum::Json(serde_json::json!({"available":false}));
    }
    let usage = unsafe { usage.assume_init() };
    let cpu_ms = (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64 * 1000.
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1000.;
    let max_rss_kib = if cfg!(target_os = "macos") {
        usage.ru_maxrss as f64 / 1024.
    } else {
        usage.ru_maxrss as f64
    };
    axum::Json(
        serde_json::json!({"available":true,"activeCars":super::ACTIVE_CARS.load(std::sync::atomic::Ordering::Relaxed),"cpuMs":cpu_ms,"processLifetimeMaxRssKiB":max_rss_kib}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_foreign_origin() {
        let request = Request::builder()
            .uri("/fleet")
            .header("origin", "https://evil.example")
            .body(())
            .unwrap();
        assert!(!origin_allowed(&request));
    }
    #[test]
    fn accepts_local_origin() {
        let request = Request::builder()
            .uri("/fleet")
            .header("origin", "http://127.0.0.1:3100")
            .body(())
            .unwrap();
        assert!(origin_allowed(&request));
    }
}
