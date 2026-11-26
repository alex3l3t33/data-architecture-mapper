# Obsidian Community Plugins release

Run the release checks from a clean checkout.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Keep the version aligned in `manifest.json`, `package.json`, and `package-lock.json`. Add its minimum app version to `versions.json` when applicable. Push the source and publish a GitHub release whose tag exactly matches the manifest version. Upload `main.js`, `manifest.json`, and `styles.css` as separate assets.

For the initial listing, sign in to the Obsidian Community directory, connect the GitHub account that owns the repository, and choose **Plugins → New plugin**. Submit the public repository URL with the appropriate owner. The directory checks the release and displays any issues to resolve before listing. [Obsidian submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin)
