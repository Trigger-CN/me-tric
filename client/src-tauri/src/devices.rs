//! Multi-device connection registry.
//!
//! me-tric keeps one `GatewayTransport` per known ME Gateway. Each transport owns
//! its own Noise session, cookie jar and request counter, so transports are never
//! shared or cloned across devices.
//!
//! The registry is the single source of truth for "which devices can I talk to".
//! A device id is a stable, user-visible label (`local`, `office`, ...) chosen by
//! the frontend; the endpoint is what actually identifies the connection.

use std::{
    collections::BTreeMap,
    sync::Arc,
};

use tokio::sync::RwLock;

use crate::gateway::{GatewayTransport, normalize_endpoint};

/// Id used when the frontend does not ask for a specific device.
///
/// Keeping a well-known fallback means the shared `app.js` core, which knows
/// nothing about devices, keeps working unchanged.
pub const DEFAULT_DEVICE_ID: &str = "default";

/// Hard cap on registered devices.
///
/// Every device holds an open Noise channel and possibly an in-flight poll, so an
/// unbounded map would let a misbehaving frontend exhaust sockets and file
/// descriptors on the host.
pub const MAX_DEVICES: usize = 16;

#[derive(Clone, Default)]
pub struct DeviceRegistry {
    entries: Arc<RwLock<BTreeMap<String, GatewayTransport>>>,
    /// Device the frontend last selected. Not persisted: which device you had
    /// focused is session state, not identity.
    active: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub endpoint: Option<String>,
    pub active: bool,
}

impl DeviceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or re-point) a device.
    ///
    /// `activate` decides whether this also becomes the device that
    /// `device_id`-less requests target. Adding a second Gateway must *not*
    /// steal the target from the one the user is currently looking at, so the
    /// add flow passes `false` and only an explicit tab click activates.
    ///
    /// Returns the normalized endpoint so the caller can persist it.
    pub async fn configure(
        &self,
        id: &str,
        endpoint: &str,
        activate: bool,
    ) -> Result<String, String> {
        let id = validate_device_id(id)?.to_owned();
        let endpoint = normalize_endpoint(endpoint)?;
        let transport = GatewayTransport::new(Some(endpoint.clone()))?;
        self.insert(id.clone(), transport).await?;
        if activate {
            *self.active.write().await = Some(id);
        }
        Ok(endpoint)
    }

    /// Restore a device without marking it active and without disturbing a live one.
    ///
    /// Used at startup to rebuild the registry from remembered devices. Skipping
    /// ids that are already registered matters: a frontend reload re-runs
    /// `client_bootstrap`, and replacing the transport would throw away that
    /// device's Noise session and session cookie, forcing a fresh login every time
    /// the window reloads.
    pub async fn restore(&self, id: &str, endpoint: &str) -> Result<(), String> {
        let id = validate_device_id(id)?.to_owned();
        let endpoint = normalize_endpoint(endpoint)?;
        if self.entries.read().await.contains_key(&id) {
            return Ok(());
        }
        let transport = GatewayTransport::new(Some(endpoint))?;
        self.insert(id, transport).await
    }

    async fn insert(&self, id: String, transport: GatewayTransport) -> Result<(), String> {
        let mut entries = self.entries.write().await;
        if entries.len() >= MAX_DEVICES && !entries.contains_key(&id) {
            return Err(format!("最多只能同时管理 {MAX_DEVICES} 个设备"));
        }
        entries.insert(id, transport);
        Ok(())
    }

    pub async fn set_active(&self, id: Option<&str>) {
        *self.active.write().await = id.map(str::to_owned);
    }

    pub async fn active_id(&self) -> Option<String> {
        self.active.read().await.clone()
    }

    /// Resolve the transport for a request.
    ///
    /// `requested` is what the frontend asked for; `None` means "whatever device is
    /// active", and if nothing is active we fall back to the well-known default so a
    /// single-device frontend still works.
    pub async fn resolve(
        &self,
        requested: Option<&str>,
    ) -> Result<(String, GatewayTransport), String> {
        let entries = self.entries.read().await;
        if entries.is_empty() {
            return Err("请先选择或添加一个设备".into());
        }
        let id = match requested {
            Some(id) => id.to_owned(),
            None => {
                let active = self.active.read().await.clone();
                match active {
                    Some(id) if entries.contains_key(&id) => id,
                    _ => {
                        if entries.contains_key(DEFAULT_DEVICE_ID) {
                            DEFAULT_DEVICE_ID.to_owned()
                        } else {
                            // Deterministic single-entry fallback.
                            entries.keys().next().cloned().unwrap_or_default()
                        }
                    }
                }
            }
        };
        // `id` is moved into the tuple only on the success path, so it stays
        // available for the error message.
        match entries.get(&id).cloned() {
            Some(transport) => Ok((id, transport)),
            None => Err(format!("设备 {id} 未连接")),
        }
    }

    pub async fn remove(&self, id: &str) -> bool {
        let removed = self.entries.write().await.remove(id).is_some();
        let mut active = self.active.write().await;
        if active.as_deref() == Some(id) {
            *active = None;
        }
        removed
    }

    pub async fn status(&self) -> Vec<DeviceStatus> {
        let active = self.active.read().await.clone();
        let snapshot = {
            let entries = self.entries.read().await;
            entries
                .iter()
                .map(|(id, transport)| (id.clone(), transport.clone()))
                .collect::<Vec<_>>()
        };
        let mut statuses = Vec::with_capacity(snapshot.len());
        for (id, transport) in snapshot {
            statuses.push(DeviceStatus {
                active: active.as_deref() == Some(id.as_str()),
                endpoint: transport.endpoint().await,
                id,
            });
        }
        statuses
    }

    /// Cancel a download on every device.
    ///
    /// The frontend only knows the opaque request id, not which device started it,
    /// and each device filters by its own registry — so broadcasting is both correct
    /// and cheaper than threading a device id through every download progress event.
    pub async fn cancel_download(&self, request_id: &str) {
        let transports = {
            let entries = self.entries.read().await;
            entries.values().cloned().collect::<Vec<_>>()
        };
        for transport in transports {
            transport.cancel_download(request_id);
        }
    }
}

/// Device ids double as URL path segments in the frontend and as SQLite primary
/// keys, so keep them boring.
fn validate_device_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("设备标识不能为空".into());
    }
    if id.len() > 64 {
        return Err("设备标识过长".into());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("设备标识只能包含字母、数字、- 和 _".into());
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ids_are_restricted_to_path_and_key_safe_characters() {
        assert!(validate_device_id("office-1").is_ok());
        assert!(validate_device_id("a_b").is_ok());
        assert!(validate_device_id("").is_err());
        assert!(validate_device_id("../etc").is_err());
        assert!(validate_device_id("has space").is_err());
        assert!(validate_device_id(&"x".repeat(65)).is_err());
    }
}
