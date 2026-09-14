# Release process

Switchyard publishes one public npm package: `@vepando/switchyard`.

The internal workspaces remain separate for ownership and testing, but are bundled into the public package during `npm run build` and are marked private to prevent accidental publication.

## One-time npm setup

In the npm package settings for `@vepando/switchyard`, configure a GitHub Actions trusted publisher with:

- Organization or user: `LeonardSEO`
- Repository: `switchyard`
- Workflow: `release.yml`
- Allowed action: enable direct `npm publish`

The workflow uses OpenID Connect and `id-token: write`; it does not require a long-lived `NPM_TOKEN` secret.

## Publish a release

1. Update the root version and `packages/adapter-pi/package.json` to the same new version.
2. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run pack:check`.
3. Merge the release commit to `main`.
4. Create a GitHub Release targeting that commit with tag `vX.Y.Z`.

Publishing the GitHub Release triggers npm publishing. The workflow stops if the Git tag does not exactly match the public package version, preventing a lower or unrelated tag from publishing a newer commit.

Do not manually create a second version tag for the same commit. Existing historical tags should remain immutable; document mistakes in release notes instead of moving published tags.
