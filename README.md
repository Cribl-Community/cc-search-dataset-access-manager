# Search Dataset Access Manager

Grant, change, or remove Cribl Search dataset access for a member or a team from one page.

## Summary

Search Dataset Access Manager gives Cribl Search administrators a bulk-edit workflow for dataset permissions. The standard Search sharing UI grants access one dataset at a time. This app reverses that workflow: select a member or team first, review their access across all datasets, apply the appropriate permissions to multiple datasets, and save the changes together.

Use this app to manage a member's or team's dataset access from one place instead of updating each dataset individually.

## What This App Does

* Primary purpose: manage direct Search dataset access for one member or team at a time.
* Key capabilities:
  * Switch between members and teams
  * Select a member or team and see every dataset
  * See the current direct access level for each dataset
  * Grant, change, or remove Read, Maintainer, and Admin access, then save the changes together
  * Keep an access history of who changed which dataset, for which member or team, and which permissions were added or removed
  * Optionally send a copy of each new access-history event to Cribl Lake
* Intended users:
  * Search admins who share datasets
* Works with:
  * Cribl Search on Cribl.Cloud

## When To Use This App

* A member needs access added or removed across many datasets
* A team’s dataset permissions need a single review
* You want to confirm current direct access before changing it

## Before You Install

* Required Cribl product or deployment type: Cribl.Cloud with Cribl Search. Dataset ACL APIs are Cloud-only.
* Required permissions or roles: permission to list users and teams, and permission to read and modify Search dataset ACLs
* Required external systems or APIs: none for dataset access management; optional Cribl Lake Direct Access or Lakehouse Raw HTTP endpoint for Lake shipping
* Required configuration values: none for dataset access management; Lake shipping requires an ingest URL, an auth token, and an organization-specific External API Access entry
* Known limits or prerequisites: the signed-in user must be allowed to call the APIs declared in `config/policies.yml`

## Installation

1. Log in to Cribl and then click on **Apps->View All**
2. Click **Add App->Import from Git**.
3. Paste `https://github.com/rplahn-netizen/cc-search-dataset-access-manager` and `latest` for the release tag.
4. Click **Import**.

To install a specific version, use its release tag, such as `v1.0.16`, instead of `latest`.

### If Git Import Is Unavailable
1. Go to the app's GitHub Releases page.
2. Download the `.tgz` app package for the version you want.
3. In Cribl, go to Apps and choose import from file.
4. Upload the downloaded `.tgz` file.
5. Review the app details and complete installation.

## Configuration

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| Lake shipping | No | Sends a copy of each new access-history event to Lake. | Direct Access URL and auth token | App installation |
| External API Access | For Lake shipping | An organization administrator authorizes the hostname and port derived from the ingest URL. | `direct-access-example.cribl.cloud:10080` | Organization |

The first-run setup walks through permissions and optional Lake shipping. Choosing Lake shipping links to the [Direct Access](https://docs.cribl.io/lake/direct-access/) and [Lakehouse Raw HTTP](https://docs.cribl.io/search/source-raw-http/) instructions, then derives a copyable External API Access object from the entered ingest URL. The Setup button reopens this guide later.

## How To Use

### Typical Workflow
1. Open the app from the Apps page.
2. Choose Members or Teams.
3. Select a member or team.
4. Review Current access for each dataset.
5. Check or clear Read, Maintainer, or Admin.
6. Choose Save access and confirm the named member or team.
7. Review Access history at the bottom of the page. It keeps the newest 400 saved changes and shows the newest 10. Export downloads the full history as a JSON file. Lake shipping is optional and stays off until you configure an ingest URL and token. The URL can be a Lake Direct Access endpoint or a Lakehouse engine Raw HTTP endpoint. Turning it on sends an extra copy. The in-app history is kept either way. When the URL is a Direct Access endpoint, **Lake audit logs** opens a new Cribl Search tab for the last 7 days.

### First-Run Checklist
* Confirm you can see members, teams, and datasets
* Select one member and confirm the dataset list loads
* Change one dataset and save, then refresh to confirm the new access
* If using Lake, copy the generated host object, then append it in Apps > this app > Settings > External API Access
* Confirm a new access change shows `Sent` in the Lake column and appears in the target Dataset

## Permissions

The app reads workspace users and teams, reads Search datasets, reads direct dataset ACLs, and posts ACL updates. If a call is denied, the page shows the error and leaves other data on screen.

Access inherited from a team, a product role, or a workspace permission is not included in the ACL responses, so it is not shown as a checked box.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/products/search/users` | List Cribl.Cloud members who can use Search |
| GET | `/api/v1/system/users` | List on-prem users |
| GET | `/api/v1/system/teams` | List teams |
| GET | `/api/v1/system/teams/{id}/acl?type=datasets` | Read a team’s direct dataset access |
| GET | `/api/v1/products/search/users/{id}/acl?type=datasets` | Read a member’s direct dataset access |
| GET | `/api/v1/m/default_search/search/datasets` | List Search datasets |
| POST | `/api/v1/m/default_search/search/datasets/{id}/acl/apply` | Grant or remove a member’s dataset access |
| POST | `/api/v1/m/default_search/search/datasets/{id}/acl/teams/apply` | Grant or remove a team’s dataset access |

## External API Access

Lake shipping posts access-history events to the organization-specific HTTPS endpoint entered during setup. Dataset access management does not require external access.

### Default Configuration
* `default/policies.yml` — Cribl API paths for users, teams, datasets, and dataset ACL updates
* `default/proxies.yml` — no customer hostnames; organization-specific Lake hosts are authorized after installation

### External Endpoints
* Optional Lake Direct Access endpoint, commonly on port `10080` with an allowed `/datasets/` prefix
* Optional Lakehouse Raw HTTP endpoint on the port configured for that source

The host configuration injects `Authorization` from the encrypted `lakeIngestToken` KV entry. Use a token limited to the intended Dataset whenever possible.

## Data And Storage

The app uses its app-scoped KV store for setup completion, Lake settings, the encrypted Lake token, and up to 400 access-history events. It does not use browser storage.

KV data is scoped to one installed app and shared by users of that installation. It is not included in the `.tgz` package and does not move to another Cribl organization.

## Support

### Community Built
This app is a community contribution. It does not carry an official support commitment from Cribl. Questions and issues can be opened on [GitHub](https://github.com/rplahn-netizen/cc-search-dataset-access-manager/issues) or sent to rplahn@cribl.io.

## Known Limitations

* Dataset ACL APIs are available on Cribl.Cloud only
* The page shows direct grants. Inherited access is omitted by the ACL APIs
* Read, Maintainer, and Admin are separate policies and can be granted together
* Search calls use the `default_search` group
* Organization-specific Lake hosts must be authorized after installation; an app cannot widen its own external access

## Troubleshooting

### The App Opens But Some Features Do Not Work
Possible causes:
* The signed-in user cannot list users, teams, or datasets
* The deployment is not Cribl.Cloud
* Search dataset ACL calls were denied

### The App Cannot Connect To An API Or Service
Check:
* The app is open inside Cribl
* `config/policies.yml` still includes the endpoints in the table above
* The signed-in user can manage Search dataset sharing
* For Lake shipping, App Settings > External API Access includes the generated hostname, port, paths, and encrypted-token header injection
* The Direct Access token permits writes to the target Dataset

### The App Works Locally But Not In Cribl
Check:
* The installed package includes the current `config/policies.yml`
* The app was installed or updated after the policy changes

## Development

```bash
npm install
npm run dev
npm run package
```

The page loads live data only when it is running inside Cribl. `npm run dev` is the local preview shell.

## Project Layout

```text
src/
  App.tsx
  access.ts
  api.ts
  host-theme.ts
  lake-setup.ts
  SetupWizard.tsx
config/
  policies.yml
  proxies.yml
README.md
```

## Versioning And Releases

* Follow semantic versioning
* `npm run package` increments the patch version unless you pass `--minor`, `--major`, or `--version`

## Contributing

Open an issue or send a change to the maintainer listed under Support.

## License

This app is licensed under the terms in [LICENSE](./LICENSE).

## App Metadata

| Field | Value |
|---|---|
| App Name | Search Dataset Access Manager |
| App ID | Search-dataset-access-manager-v1 |
| Version | See `package.json` |
| Author | Rob Plahn |
| Support Model | community-built |
| Support Label | Community Built |
| Support Contact | [GitHub issues](https://github.com/rplahn-netizen/cc-search-dataset-access-manager/issues) |
| License | See LICENSE |
| License File | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Product Tags | search, lake |
| Category | administration |
| Audience | admin |
| Availability | preview |
| Requires External Access | only for optional Lake shipping |
| Repository | [github.com/rplahn-netizen/cc-search-dataset-access-manager](https://github.com/rplahn-netizen/cc-search-dataset-access-manager) |
| Documentation | https://docs.cribl.io/search/ |
| README Schema Version | 1.0 |
