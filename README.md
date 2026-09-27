# send-guard

![send-guard: check an email list before your agent sends to it](https://raw.githubusercontent.com/askeleven/send-guard/main/docs/social-preview.png)

**Check an email list before your agent sends to it, and find out whether it is safe to.**

```bash
npx @askeleven/send-guard leads.csv
```

An agent that sends to a bad list does not notice. It gets bounces nobody reads, lands
on a spam trap, and the domain's reputation is gone before a person looks at a
dashboard. send-guard is the check that runs first: a CLI for pipelines, an MCP server
for agents, and a library for everything else. It returns a pass or a fail, the
addresses to keep, and the reason for every one it removes.

Zero dependencies. The local checks need no signup and no account, and nothing leaves
your machine except DNS lookups for the domains in the list.

---

## What it checks

| Check | Where it runs | Verdict |
|---|---|---|
| **Syntax** | Local, free | Remove |
| **Duplicates**, case-insensitive | Local, free | Remove |
| **Domain cannot receive mail**: no MX, no A record, or a null MX | Local, free | Remove |
| **Parked domains**, on known parking nameservers | Local, free | Remove |
| **Disposable inboxes** | Local, free | Remove |
| **Typos** of major providers, with a suggestion (`gmial.com`, `hotmial.com`) | Local, free | Remove |
| **Role accounts** (`info@`, `sales@`, `support@`) | Local, free | Review |
| **Free providers** | Local, free | Informational |
| **Mailbox exists**, over SMTP | [Analyzemail](https://analyzemail.com) API key | Remove if not |
| **Catch-all domains** | Analyzemail API key | Review |
| **Spam traps** | Analyzemail API key | Remove |
| **Known litigators** | Analyzemail API key | Remove |
| **Security gateways** hiding mailbox status | Analyzemail API key | Review |

**Keep** means nothing was found. **Review** means a person should decide. **Remove**
means sending will bounce, or will arrive somewhere that hurts you.

The list **fails** when more than 2% of its distinct addresses should be removed
(`--max-remove` to change it). Duplicates are left out of that share: sending twice is
wasteful, not dangerous.

## Why the mailbox check needs a key

Most cloud hosts block outbound port 25 by default, so an agent running on one cannot ask
a mail server whether a mailbox exists. Even
where it can, probing from an IP with no reputation gets refused or blocklisted. That
check needs infrastructure, so it runs on [Analyzemail](https://analyzemail.com), which
we also make.

Set `ANALYZEMAIL_API_KEY` ([get one here](https://analyzemail.com/account/settings/api))
and send-guard checks every address that **passed** the local checks. It never spends a
credit on an address it has already ruled out, or on a duplicate. One credit per address,
and a check the mail server does not answer is refunded.

**250 mailbox checks a month are free** on any Analyzemail account with a confirmed email
address. They reset at 00:00 UTC on the 1st, do not roll over, and are spent before any
credits you buy. Until an account has bought credits, it is limited to 2 checks a second
and 500 a day; send-guard waits out the per-second limit on its own.
[AskEleven](https://askeleven.com) customers get 25,000 a month.

Before spending anything it checks your balance and refuses to start if the list would
cost more than `--max-credits` (default 1,000), so an agent cannot spend more than you
expect.

## What it does not do

**Without a key, it cannot tell you a mailbox exists.** A list can pass every local check
and still bounce 20% when the people on it left their jobs. The report says so when
mailboxes were not checked, rather than letting a pass imply more than it means.

**It does not send anything, or fix anything.** A probable typo comes with a suggestion,
not a correction. Whether `bob@gmial.com` meant `bob@gmail.com` is for a person to
confirm.

**It does not treat a DNS failure as a dead domain.** If the resolver does not answer,
those addresses are marked review, not remove.

---

## Example

```
$ npx @askeleven/send-guard leads.csv --out clean.csv

FAIL  50% of the list should be removed (limit 2%)

           4 checked
           1 keep
           1 review
           2 remove

REMOVE
  Disposable inbox (1)
      al@sharklasers.com
  Probable typo (1)
      bob@hotmial.com  did you mean bob@hotmail.com?

REVIEW
  Shared inbox (role account) (1)
      sales@acme.com

  Mailboxes were not checked. 2 addresses passed the local checks, which
  catch addresses that can never work but cannot tell whether a mailbox
  exists. Set ANALYZEMAIL_API_KEY to check them (one credit each; key at
  https://analyzemail.com/account/settings/api).
Wrote the addresses to keep to clean.csv
```

`clean.csv` keeps the header and every other column, so it drops straight back into
whatever the list came from.

## Options

```
--column <name|n>     Email column in a CSV. Found automatically otherwise.
--max-remove <pct>    Fail when more than this share should be removed. Default 2.
--max-credits <n>     Refuse to spend more than this on mailbox checks. Default 1000.
--out <file>          Write the addresses to keep, in the input's format.
--include-review      Also write addresses marked review to --out.
--no-mailbox          Local checks only, even with an API key set.
--no-dns              Skip DNS lookups. Syntax and list checks only.
--dns <ip>            Resolver to query. Repeatable.
--json                Machine-readable output.
--all                 List every flagged address, not the first ten per reason.
--no-colour           Plain text.
```

Input is a CSV (comma, semicolon or tab), a plain list with one address per line,
addresses on the command line, or standard input.

Exit code `0` means safe to send, `1` means not safe as it stands, `2` means it could not
run. So it gates a pipeline:

```bash
npx @askeleven/send-guard list.csv --out clean.csv && ./send-campaign clean.csv
```

## For agents: MCP server

```bash
npx @askeleven/send-guard mcp
```

It serves two tools over stdio: `check_emails` (up to 5,000 addresses inline) and
`check_file` (a CSV or text file on disk, optionally writing the clean list to
`out_path`). Both return `passed`, the addresses to `keep`, and the `remove` and `review`
lists, each with a reason code and a plain-English explanation.

**Claude Code**

```bash
claude mcp add send-guard -e ANALYZEMAIL_API_KEY=am_live_... -- npx -y @askeleven/send-guard mcp
```

**Claude Desktop, Cursor, and other clients** that take a JSON config:

```json
{
  "mcpServers": {
    "send-guard": {
      "command": "npx",
      "args": ["-y", "@askeleven/send-guard", "mcp"],
      "env": { "ANALYZEMAIL_API_KEY": "am_live_..." }
    }
  }
}
```

Leave out the `env` block for local checks only.

The server tells the model how to use the result: do not send to a list that failed,
send to `keep`, show `review` to a person rather than deciding, and never substitute a
typo suggestion without asking.

## As a library

```js
import { checkList, createClient } from '@askeleven/send-guard'

const report = await checkList(addresses, {
  client: createClient({ apiKey: process.env.ANALYZEMAIL_API_KEY }), // optional
})

if (!report.summary.passed) {
  const keep = report.addresses.filter((a) => a.verdict === 'keep').map((a) => a.email)
  // send to keep, or stop and ask
}
```

Every reason has a stable `code` (`syntax`, `disposable`, `mailbox_undeliverable`, and so
on) to match on, and a `detail` to show a person. `createFixtureResolver()` is exported
so you can test without touching the network.

## Privacy

With no API key, the only thing that leaves your machine is a DNS query for each distinct
domain in the list. Addresses are not sent anywhere.

With a key, each address that passed the local checks is sent to Analyzemail to be
verified, under [its privacy policy](https://analyzemail.com/privacy). `--no-mailbox` (or
`check_mailboxes: false` over MCP) turns that off for one run.

## Requirements

Node 20 or newer. No dependencies.

---

## Why we built it

[AskEleven](https://askeleven.com) runs AI employees that send email on behalf of small
businesses. The first time an agent is handed a spreadsheet and asked to "follow up with
everyone", it will, including the 400 addresses that bounced two years ago. Nothing about
the agent is broken. Nobody told it to check.

This is that check, made free wherever it can be. The disposable, role and parking lists
are the ones Analyzemail uses server-side, so a local verdict and an API verdict agree.

## Contributing

Issues and pull requests welcome, especially:

- **Disposable domains we are missing**, with a link showing the service hands out
  inboxes.
- **Wrong verdicts.** If an address is removed that should not be, open an issue with the
  domain (not the full address) and we will fix it.
- **MCP clients** where the server does not work as documented.

Run the tests with `npm test`. They use fixture DNS and a fake API client, so they are
offline and fast.

## License

MIT. See [LICENSE](LICENSE).

Removing a litigator or a spam trap from a list is risk reduction, not compliance. Consent
is still yours to get.
