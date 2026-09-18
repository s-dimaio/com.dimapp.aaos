# Android Automotive for Homey (Companion App) 🚗🏡

This is the companion application for **Homey for Android Automotive**. It runs on your Homey Pro and acts as a secure OAuth2 relay and data provider for the native Android Automotive OS (AAOS) application installed in your vehicle.

## 🌟 Overview

The **Android Automotive** companion app bridges the gap between your car's infotainment system and your smart home. It handles the complex authentication handshake with the Athom Cloud and provides a streamlined API for the car app to monitor and control your devices safely while driving.

## ✨ Key Features

- **Secure OAuth2 Relay & Session Management**: Facilitates the QR code-based pairing process between the car and your Homey account with transparent session renewal.
- **Flow Execution Proxy**: Securely triggers Standard and Advanced Homey Flows invoked from the car using the official HomeyScript app integration.
- **Proximity Geofence Support**: Reports Homey Pro location and exposes user-selected barrier devices for departure alerts and arrival prompts.
- **Climate & Sensor Classification**: Provides temperature sensor mapping (indoor vs outdoor) for in-car climate widgets.
- **Diagnostic File Logging**: Robust rotatable persistent logging system with download and management tools in the app settings.
- **Device Management**: Allows you to configure which devices and zones are visible on your car's dashboard.

## 🏗️ Architecture

This app is the "server-side" component of the integration:
1. **Homey Companion App** (this repo): Installed on Homey Pro.
2. **Android Automotive App**: Native Kotlin app installed in the vehicle. [Repository here](https://github.com/s-dimaio/HomeyAutomotive).

The car app communicates with this companion app via a secure, authenticated bridge to fetch zones, devices, and trigger actions.

## 🚀 Installation & Development

### Prerequisites
- [Homey CLI](https://npm.im/homey) installed on your machine.
- Node.js 22 or higher.

### Local Setup
1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the app in development mode:
   ```bash
   homey app run
   ```

### Staging/Production
To install the app permanently on your Homey Pro:
```bash
homey app install
```

## 🛠️ API Endpoints

This app exposes endpoints used by the AAOS client:
- `POST /auth/start`: Initiates the pairing process and generates the QR code URL.
- `GET /auth/poll`: Polls for one-time token delivery upon user authorization.
- `POST /auth/refresh`: Refreshes and rotates the hub session token silently.
- `POST /flow/trigger`: Executes a Standard or Advanced Flow via the HomeyScript proxy.
- `GET /location`: Retrieves Homey Pro coordinates for in-car geofencing.
- `GET /geofence`: Retrieves configured proximity barrier device IDs.
- `GET /thermometers`: Retrieves thermometer climate classification configuration.
- `GET /devices`: Retrieves the list of devices configured for car access.
- `GET /zones`: Retrieves the room hierarchy.
- `GET /dashboards`: Retrieves virtual dashboard configuration.

## 📄 License

This project is licensed under the GNU GPL v3 License.
