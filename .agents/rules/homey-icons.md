# Homey Assets & Icons

Whenever creating, generating, or modifying any SVG icons (app, driver, custom capability) or App Store promotional images for an Athom Homey Pro app (SDK v3):
- You **MUST** activate and strictly follow the skill `homey-icon-creator`.
- Ensure all vector icons strictly use `viewBox="0 0 960 960"` with a 100% transparent background.
- Validate all generated assets using the skill's automated scripts (`validate_icon.js` for SVGs, `validate_store_images.js` for store images).
