mod certs;
mod transport;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, watch, Notify, Semaphore},
    time::MissedTickBehavior,
};
use transport::{FleetRecv, FleetSend};
use wtransport::{Endpoint, Identity, ServerConfig};
const CAP: usize = 32;
static ACTIVE_CARS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct ActiveCar;
impl ActiveCar {
    fn new() -> Self {
        ACTIVE_CARS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self
    }
}
impl Drop for ActiveCar {
    fn drop(&mut self) {
        ACTIVE_CARS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    car_id: u16,
    rate: u16,
    paused: bool,
    delivery_delay_ms: u16,
}
impl Settings {
    fn valid(&self) -> bool {
        self.car_id < 64 && (10..=1000).contains(&self.rate) && self.delivery_delay_ms <= 250
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    car_id: u16,
    sequence: u64,
    generated_at_ms: f64,
    x: f64,
    y: f64,
    heading: f64,
    speed: f64,
    queued: usize,
    coalesced: u64,
}
#[derive(Default)]
struct Queue {
    items: VecDeque<Sample>,
    coalesced: u64,
}
impl Queue {
    fn push(&mut self, s: Sample) {
        if self.items.len() == CAP {
            self.items.pop_front();
            self.coalesced += 1;
        }
        self.items.push_back(s);
    }
}
fn position(id: u16, d: f64) -> (f64, f64, f64) {
    let x = 160. + 240. * f64::from(id % 4);
    let y = 160. + 180. * f64::from((id / 4) % 3);
    let w = 240. * f64::from(1 + (id % ((1360. - x) as u16 / 240)));
    let h = 180. * f64::from(1 + ((id / 3) % ((880. - y) as u16 / 180)));
    let t = (d + f64::from(id) * 173.).rem_euclid(2. * (w + h));
    if t < w {
        (x + t, y, 0.)
    } else if t < w + h {
        (x + w, y + t - w, std::f64::consts::FRAC_PI_2)
    } else if t < 2. * w + h {
        (x + 2. * w + h - t, y + h, std::f64::consts::PI)
    } else {
        (x, y + 2. * (w + h) - t, -std::f64::consts::FRAC_PI_2)
    }
}
fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}
fn frame(kind: u16, req: u32, value: &impl Serialize) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap();
    let mut b = Vec::with_capacity(12 + payload.len());
    b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    b.extend_from_slice(&512u16.to_be_bytes());
    b.extend_from_slice(&kind.to_be_bytes());
    b.extend_from_slice(&req.to_be_bytes());
    b.extend(payload);
    b
}
async fn read_frame(
    r: &mut FleetRecv,
    buffer: &mut Vec<u8>,
) -> Result<(u16, u32, Settings), String> {
    loop {
        if buffer.len() >= 12 {
            let len = u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
            if len > 4096 {
                return Err("Control frame too large".into());
            }
            if buffer.len() >= len + 12 {
                let kind = u16::from_be_bytes(buffer[6..8].try_into().unwrap());
                let req = u32::from_be_bytes(buffer[8..12].try_into().unwrap());
                if buffer[4..6] != 512u16.to_be_bytes() {
                    return Err("Invalid channel".into());
                }
                let s: Settings =
                    serde_json::from_slice(&buffer[12..12 + len]).map_err(|e| e.to_string())?;
                buffer.drain(..12 + len);
                if !s.valid() {
                    return Err("Invalid settings".into());
                }
                return Ok((kind, req, s));
            }
        }
        let b = r.read_chunk().await?;
        buffer.extend_from_slice(&b);
    }
}
async fn car(mut send: FleetSend, mut recv: FleetRecv, ids: Arc<Mutex<HashSet<u16>>>) {
    let _activity = ActiveCar::new();
    let mut buffer = vec![];
    let Ok(Ok((0x1000, req, initial))) =
        tokio::time::timeout(Duration::from_secs(5), read_frame(&mut recv, &mut buffer)).await
    else {
        return;
    };
    let id = initial.car_id;
    if !ids.lock().unwrap().insert(id) {
        let _ = send.write_all(&frame(255, req, &"Duplicate car")).await;
        return;
    }
    let stream_id = send.id();
    let ack = |req, s: &Settings| {
        frame(
            0x1003,
            req,
            &serde_json::json!({"streamId":stream_id,"settings":s}),
        )
    };
    if send.write_all(&ack(req, &initial)).await.is_err() {
        ids.lock().unwrap().remove(&id);
        return;
    }
    let (settings, mut changes) = watch::channel(initial.clone());
    let writer_settings = settings.subscribe();
    let (acks, mut responses) = mpsc::channel::<Vec<u8>>(8);
    let q = Arc::new(Mutex::new(Queue::default()));
    let notify = Arc::new(Notify::new());
    let reader = async {
        loop {
            let (kind, req, s) = read_frame(&mut recv, &mut buffer).await?;
            if !matches!(kind, 0x1001 | 0x1004) || s.car_id != id {
                return Err::<(), String>("Unexpected control".into());
            }
            if kind == 0x1004 {
                acks.send(ack(req, &s)).await.map_err(|e| e.to_string())?;
                continue;
            }
            if s.paused {
                q.lock().unwrap().items.clear();
            }
            settings.send(s.clone()).map_err(|e| e.to_string())?;
            acks.send(ack(req, &s)).await.map_err(|e| e.to_string())?;
        }
    };
    let producer = async {
        let mut s = initial.clone();
        let mut ticker = tokio::time::interval(Duration::from_secs_f64(1. / f64::from(s.rate)));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut last = Instant::now();
        let mut distance = 0.;
        let mut sequence = 0;
        loop {
            tokio::select! {_=changes.changed()=>{s=changes.borrow_and_update().clone();ticker=tokio::time::interval(Duration::from_secs_f64(1./f64::from(s.rate)));ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);last=Instant::now();},_=ticker.tick()=>{let now=Instant::now();let dt=now.duration_since(last).as_secs_f64();last=now;if !s.paused{let speed=25.+f64::from(id%15);distance+=speed*dt;sequence+=1;let (x,y,heading)=position(id,distance);q.lock().unwrap().push(Sample{car_id:id,sequence,generated_at_ms:epoch_ms(),x,y,heading,speed:speed*1.8,queued:0,coalesced:0});notify.notify_one();}}}
        }
    };
    let writer = async {
        loop {
            tokio::select! {biased;Some(b)=responses.recv()=>{send.write_all(&b).await.map_err(|e|e.to_string())?;},_=notify.notified()=>{}}
            loop {
                while let Ok(b) = responses.try_recv() {
                    send.write_all(&b).await.map_err(|e| e.to_string())?;
                }
                let delay = writer_settings.borrow().delivery_delay_ms;
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(u64::from(delay))).await;
                }
                let sample = {
                    let mut queue = q.lock().unwrap();
                    if writer_settings.borrow().paused {
                        queue.items.clear();
                    }
                    let mut sample = queue.items.pop_front();
                    if let Some(s) = sample.as_mut() {
                        s.queued = queue.items.len();
                        s.coalesced = queue.coalesced;
                    }
                    sample
                };
                let Some(s) = sample else {
                    break;
                };
                send.write_all(&frame(0x1002, 0, &s))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), String>(())
    };
    tokio::select! {_=reader=>{},_=producer=>{},_=writer=>{}}
    ids.lock().unwrap().remove(&id);
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cert = certs::generate_self_signed_cert()?;
    certs::save_certs(&cert, std::path::Path::new("certs"))?;
    let identity = Identity::load_pemfiles("certs/cert.pem", "certs/key.pem").await?;
    let mut transport = wtransport::config::QuicTransportConfig::default();
    transport.max_concurrent_bidi_streams(128u32.into());
    let config = ServerConfig::builder()
        .with_bind_address("127.0.0.1:4434".parse()?)
        .with_custom_transport(identity, transport)
        .build();
    let endpoint = Endpoint::server(config)?;
    let websocket = transport::websocket_server().await?;
    let pin = cert.cert_hash_base64;
    let app=axum::Router::new().route("/api/config",axum::routing::get(move||{let pin=pin.clone();async move{([(axum::http::header::CACHE_CONTROL,"no-store")],axum::Json(serde_json::json!({"url":"https://127.0.0.1:4434/fleet","pin":pin,"websocketUrl":"wss://127.0.0.1:4445/fleet","queueCapacity":CAP,"maxCars":64})))}})).route("/api/metrics",axum::routing::get(transport::metrics)).route("/api/health",axum::routing::get(||async{"ok"})).fallback_service(tower_http::services::ServeDir::new("../frontend/dist"));
    let port = if std::env::args().any(|a| a == "--production") {
        3100
    } else {
        9101
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Fleet HTTP 127.0.0.1:{port}; WebTransport UDP 4434");
    let permits = Arc::new(Semaphore::new(8));
    let quic = async {
        loop {
            let incoming = endpoint.accept().await;
            let permits = permits.clone();
            tokio::spawn(async move {
                let Ok(_permit) = permits.try_acquire_owned() else {
                    return;
                };
                let Ok(Ok(request)) = tokio::time::timeout(Duration::from_secs(5), incoming).await
                else {
                    return;
                };
                if !matches!(
                    request.origin(),
                    Some("http://127.0.0.1:3100" | "http://localhost:3100")
                ) || request.path() != "/fleet"
                {
                    request.forbidden().await;
                    return;
                }
                if let Ok(conn) = request.accept().await {
                    let ids = Arc::new(Mutex::new(HashSet::new()));
                    let mut tasks = tokio::task::JoinSet::new();
                    loop {
                        tokio::select! {result=conn.accept_bi()=>{match result{Ok((s,r)) if tasks.len()<64=>{tasks.spawn(car(FleetSend::Quic(s),FleetRecv::Quic(r),ids.clone()));},Ok(_)=>{},Err(_)=>break}},_=tasks.join_next(),if !tasks.is_empty()=>{}}
                    }
                    tasks.abort_all();
                }
            });
        }
    };
    tokio::select! {_=quic=>{},_=websocket=>{},r=axum::serve(listener,app)=>{r?;},_=tokio::signal::ctrl_c()=>{}}
    endpoint.close(0u32.into(), b"Stopping");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_stay_on_roads() {
        for id in 0..64 {
            for d in (0..10000).step_by(13) {
                let (x, y, h) = position(id, f64::from(d));
                assert!(
                    (160.0..=1360.0).contains(&x) && (160.0..=880.0).contains(&y) && h.is_finite()
                );
                assert!(
                    ((x - 160.) / 240.).fract().abs() < 1e-8
                        || ((y - 160.) / 180.).fract().abs() < 1e-8
                );
            }
        }
    }
    #[test]
    fn queue_retains_latest() {
        let mut q = Queue::default();
        for sequence in 0..100 {
            q.push(Sample {
                car_id: 0,
                sequence,
                generated_at_ms: 0.,
                x: 0.,
                y: 0.,
                heading: 0.,
                speed: 0.,
                queued: 0,
                coalesced: 0,
            });
        }
        assert_eq!(q.items.len(), 32);
        assert_eq!(q.coalesced, 68);
        assert_eq!(q.items.front().unwrap().sequence, 68);
    }
    #[test]
    fn invalid_controls_rejected() {
        let mut s = Settings {
            car_id: 63,
            rate: 120,
            paused: false,
            delivery_delay_ms: 250,
        };
        assert!(s.valid());
        s.car_id = 64;
        assert!(!s.valid());
        s.car_id = 0;
        s.rate = 1000;
        assert!(s.valid());
        s.rate = 1001;
        assert!(!s.valid());
        s.rate = 0;
        assert!(!s.valid());
    }
}
