# Security policy

## Reporting a vulnerability

Report privately to the maintainer, by direct message:

- Telegram: **[@markinho22](https://t.me/markinho22)**
- Discord: **marcom4085**

Please do not open a public issue, pull request or discussion for a
vulnerability. Check the handle exactly before you write: these are the only
two contacts, and anyone else claiming to collect reports for this project is
not us.

Include what you found, how to reproduce it, and what an attacker could do with
it. **Never send private keys, seed phrases or API keys**, yours or anyone
else's: nobody working on this project will ever ask for them.

We aim to acknowledge a report within a few days and to keep you informed until
it is resolved. There is no bug bounty.

## Scope

In scope: the code in this repository, including the deployment files in
`deploy/`, `Dockerfile` and `docker-compose.yml`, for example:

- a way to make the bot sign or submit a transaction that loses funds beyond
  its network fee;
- a way to drive it from Telegram beyond what the command rules allow;
- anything that would expose the key, the RPC credentials or the Telegram token.

Out of scope: the protocols the bot uses. Report issues in Kamino Lend, Orca or
Scope to those projects directly.

## Supported versions

Only the `main` branch is maintained.
