# Android Automotive for Homey (Companion App) 🚗🏡

This is the companion application for **Homey for Android Automotive**. It runs on your Homey Pro and acts as a secure OAuth2 relay, geofencing bridge, and data provider for the native Android Automotive OS (AAOS) application installed in your vehicle.

## 🌟 Overview

The **Android Automotive** companion app bridges the gap between your car's infotainment system and your smart home. It handles the authentication handshake with the Athom Cloud, enforces strict hub-level role-based access control (RBAC), and provides a hardened, streamlined API for the car app to monitor and control your devices safely while driving.

## ✨ Key Features

- **Hardened OAuth2 Relay & Session Management**:
  - Facilitates a seamless QR code-based pairing flow between the vehicle and your Homey account with automatic token renewal.
  - **Strict Server-Side RBAC & Hub Membership Check**: Authenticates user tokens with Athom Cloud and validates against the local Homey user registry. Only active `owner`, `manager`, and resident `user` accounts are permitted; `guest` and disabled accounts are blocked with HTTP 403 Forbidden.
  - **Rate Limiting & DoS Protection**: In-memory sliding-window rate limiting on public endpoints (`/auth/start` and `/auth/refresh`) and memory pool capping (max 3 concurrent pending sessions) with automatic listener and timer cleanup.
  - **Strict Input Validation**: Enforces exact 64-character hexadecimal format for session identifiers and validates all incoming payloads.
- **Proximity Geofence Support & Triggers**:
  - Exposes Homey Pro coordinates (`/location`) for on-device vehicle geofencing.
  - Exposes user-selected barrier devices (`/geofence`) for departure warnings and arrival shortcuts.
  - Receives vehicle transition events (`POST /geofence/event`) to trigger welcome/departure automations.
- **Climate & Sensor Classification**:
  - Provides thermometer climate mapping (indoor vs outdoor) via `/thermometers` for in-car dashboard temperature widgets.
- **Diagnostic File Logging & PII Sanitization**:
  - Persistent, auto-rotating diagnostic file logger (`LogManager.js`) writing up to 512KB per file with 3 rotating backups in `/userdata`.
  - Comprehensive, centralized masking of sensitive credentials and PII: Bearer tokens, passwords, secrets, session IDs, Athom ObjectIds (`677c***6f27`), GDPR emails, and GPS coordinates.
  - Real-time diagnostic viewer and log file management (download/delete) in the app settings page.
- **Virtual Dashboard & Device Filtering**:
  - Configure up to 9 quick-access devices (lights, locks, garage doors, doorbells) and zones visible on your car dashboard.

## 🎛️ Flow Cards

This app provides Flow triggers to automate your home based on your vehicle's movements:

### Triggers
- **Vehicle entered home geofence** (`geofence_enter`): Triggers when your vehicle crosses into the home proximity perimeter.
- **Vehicle exited home geofence** (`geofence_exit`): Triggers when your vehicle leaves the home proximity perimeter.

## 🏗️ Architecture
1. **Homey Companion App** (this repository): Installed on your Homey Pro.
2. **Android Automotive App**: Native Kotlin app installed in the vehicle. [Repository here](https://github.com/s-dimaio/HomeyAutomotive).

The vehicle app communicates with this companion app via a secure bridge for bootstrapping authentication and synchronizing geofence/climate configuration, while querying the Homey Pro REST API directly for real-time device control, flows, and telemetry.

## 🚀 Installation & Development

### Prerequisites
- [Homey CLI](https://npm.im/homey) installed on your machine (`npm install -g homey`).
- Node.js 22 or higher.

### Local Setup
1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the app in development mode with live debugging:
   ```bash
   homey app run
   ```

### Staging / Production
To install the app permanently on your Homey Pro:
```bash
homey app install
```

To validate the manifest against Homey App Store publication standards:
```bash
npx homey app validate --level publish
```

## 🛠️ API Endpoints

This app exposes endpoints used by the AAOS client:

### Public Endpoints (Rate-limited, no bearer token required)
- `POST /auth/start`: Initiates the pairing process and generates the QR code URL (strictly validates 64-char hex `sessionId`, rate-limited to 5 req/5min).
- `GET /auth/poll`: Polls for one-time token delivery upon user authorization (strictly validates 64-char hex `session`).
- `POST /auth/refresh`: Refreshes and rotates the hub session token with Athom Cloud, re-verifying hub membership permissions (rate-limited to 10 req/5min).

### Protected Endpoints (Require valid Homey Pro API Bearer Token)
- `GET /location`: Retrieves Homey Pro coordinates for in-car geofencing.
- `GET /geofence`: Retrieves configured proximity barrier device IDs.
- `POST /geofence/event`: Reports in-vehicle geofence arrival/departure transitions to trigger Homey flow cards.
- `GET /thermometers`: Retrieves thermometer climate classification configuration.
- `GET /devices`: Retrieves the list of filtered devices configured for car access.
- `GET /zones`: Retrieves the room hierarchy.
- `GET /dashboards`: Retrieves virtual dashboard configuration.
- `GET /log/status`: Retrieves current diagnostic log status, active file size, and file list.
- `GET /log/download/:index`: Downloads a diagnostic log file (0..2, index strictly validated).
- `DELETE /log/:index`: Clears a specific diagnostic log file (0..2).
- `DELETE /log/all`: Clears all diagnostic log files.

## 📄 License

This project is licensed under the GNU GPL v3 License.
