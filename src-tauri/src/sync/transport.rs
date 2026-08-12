// The seam between the sync state machine and Google. The engine never calls `api::*` directly, so
// pagination, 410 recovery and the outbox drain can be driven by a stub over an in-memory database
// in `cargo test`, which is the only way any of this is testable without credentials.
//
// Account resolution lives behind the trait as well: the engine names an account, the transport
// turns that into a bearer token. `auth::valid_access_token` is single-flight, so it is called per
// request rather than cached here.

use std::future::Future;

use tauri::Manager;

use crate::google::api::{self, ApiError, CalendarListPage, EventsPage, RawEvent};

pub trait Transport: Sync {
    fn calendar_list(
        &self,
        account_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl Future<Output = Result<CalendarListPage, ApiError>> + Send;

    fn events_list(
        &self,
        account_id: &str,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl Future<Output = Result<EventsPage, ApiError>> + Send;

    fn events_insert(
        &self,
        account_id: &str,
        calendar_id: &str,
        body: &serde_json::Value,
    ) -> impl Future<Output = Result<RawEvent, ApiError>> + Send;

    fn events_patch(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        body: &serde_json::Value,
        etag: Option<&str>,
    ) -> impl Future<Output = Result<RawEvent, ApiError>> + Send;

    fn events_delete(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        etag: Option<&str>,
    ) -> impl Future<Output = Result<(), ApiError>> + Send;

    fn events_instances(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        original_start: &str,
    ) -> impl Future<Output = Result<Vec<RawEvent>, ApiError>> + Send;
}

pub struct Google {
    pub app: tauri::AppHandle,
}

impl Google {
    async fn token(&self, account_id: &str) -> Result<String, ApiError> {
        let state = self.app.state::<crate::google::AuthState>();
        crate::google::auth::valid_access_token(&self.app, &state, account_id)
            .await
            .map_err(ApiError::Other)
    }
}

impl Transport for Google {
    fn calendar_list(
        &self,
        account_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl Future<Output = Result<CalendarListPage, ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::calendar_list(&access, sync_token, page_token).await
        }
    }

    fn events_list(
        &self,
        account_id: &str,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl Future<Output = Result<EventsPage, ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::events_list(&access, calendar_id, sync_token, page_token).await
        }
    }

    fn events_insert(
        &self,
        account_id: &str,
        calendar_id: &str,
        body: &serde_json::Value,
    ) -> impl Future<Output = Result<RawEvent, ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::events_insert(&access, calendar_id, body).await
        }
    }

    fn events_patch(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        body: &serde_json::Value,
        etag: Option<&str>,
    ) -> impl Future<Output = Result<RawEvent, ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::events_patch(&access, calendar_id, event_id, body, etag).await
        }
    }

    fn events_delete(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        etag: Option<&str>,
    ) -> impl Future<Output = Result<(), ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::events_delete(&access, calendar_id, event_id, etag).await
        }
    }

    fn events_instances(
        &self,
        account_id: &str,
        calendar_id: &str,
        event_id: &str,
        original_start: &str,
    ) -> impl Future<Output = Result<Vec<RawEvent>, ApiError>> + Send {
        async move {
            let access = self.token(account_id).await?;
            api::events_instances(&access, calendar_id, event_id, original_start).await
        }
    }
}
