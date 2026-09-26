# Peer note — `docs/BACKUP-RESTORE.md` still says there is no off-host copy

**From:** the cloud-readiness / recovery lane
**To:** whoever owns the off-host shipping work (the reconciliation doc credits
Window 2 with installing the drop-in on 2026-09-23)
**Date:** 2026-09-26
**Nothing in your file has been edited.** Same pattern as
`PEER-NOTE-MODEL-COUNT-CORRECTION.md`: the finding, the evidence, and suggested
replacement text. Fold in, reword or reject — your call.

## Why this one is worth interrupting you for

The other stale-doc findings in this lane are about features a client reads
about. This one is different: **`docs/BACKUP-RESTORE.md` is the document an
operator opens during a host-loss event**, and in three places it tells them no
off-host copy exists. Someone following it after losing this machine would
conclude the archives are gone with the disk and never look at the destination
where five of them are currently sitting.

It is stale, not wrong-at-the-time. It was accurate when written; the off-host
send was armed three days later and nobody came back to §6/§7/§8.

## The evidence that it is stale

All of this is already committed in this same repo, which is what makes the
contradiction awkward — `docs/BACKUP-EVIDENCE-RECONCILIATION.md` says:

| Line | Says |
|---|---|
| 13 | "Nightly off-host send is **ARMED** — drop-in `/etc/systemd/system/atc-pos-backup.service.d/10-offhost.conf` installed 2026-09-23 16:18:39Z (Window 2)" |
| 12 | "Owner's 2026-09-23 16:20 UTC run succeeded — `pos-prod-20260923T162012Z.tar.gpg` shipped 16:20:18.882Z, `status=ok`" |
| 15 | "Prior verified copy — 2026-09-23 15:04Z at `atc@20.20.20.57:/home/atc/atc-backups/pos-prod-offhost/`" |

And the local shipping log `~/atc-backups/offhost-state/offhost.log` records
**five consecutive successes**, the most recent last night:

```
2026-09-23T15:04:27.673Z ship ok pos-prod-20260923T145905Z.tar.gpg
2026-09-23T16:20:18.882Z ship ok pos-prod-20260923T162012Z.tar.gpg
2026-09-23T21:15:01.886Z ship ok pos-prod-20260923T211456Z.tar.gpg
2026-09-24T21:14:11.397Z ship ok pos-prod-20260924T211406Z.tar.gpg
2026-09-25T21:14:34.720Z ship ok pos-prod-20260925T211428Z.tar.gpg
```

One of those archives has been decrypted and fully restored: the 09-24 archive
returned **22/22 PASS** against the manifest read from inside it (recorded in
`docs/CLOUD-READINESS-VERIFICATION.md`). So the chain is not merely shipped, it
is proven restorable from ciphertext.

I read the log on this host only. **I did not touch 20.20.20.57** — your
reconciliation note at line 5 records it as the prohibited VM lab, and that
still holds for me.

## The three places, and suggested replacements

### Line 368, §6 "What has actually been proven"

Current: *"There is no off-host copy of anything. Both dumps and the database
they came from are on the same disk. That is not a backup policy, it is a
faster-to-restore copy, and it does not survive the loss of this machine."*

Suggested:

```text
- Off-host copies exist and are current. The nightly send has been armed since
  2026-09-23 16:18:39Z and has shipped five consecutive nights to
  `atc@20.20.20.57:/home/atc/atc-backups/pos-prod-offhost/`; the most recent is
  `pos-prod-20260925T211428Z.tar.gpg`. One of them — the 09-24 archive — has
  been decrypted and restored from ciphertext, 22/22 against the manifest
  carried inside it. What this does NOT yet survive is loss of the *site*: the
  destination is on the same /24, so it is a replica, not a DR copy.
```

### Lines 394–398, §7 gap 1

Current: *"**No off-host copy.** Highest-value next step by a wide margin …"*

That gap is closed. Suggested replacement, which keeps a gap in the slot rather
than deleting the numbering:

```text
1. **The off-host copy is on-site.** Shipping works and is proven restorable,
   but 20.20.20.57 is on the same /24 as the source. It survives losing the
   machine; it does not survive losing the room. A genuinely independent
   destination is now the highest-value step.
```

### Lines 410–414, §8 status block

Current: *"**Status: written, not yet run.** Nothing in this section has been
executed, because it cannot be until someone names a destination …"*

Suggested:

```text
**Status: run, and proven end to end.** The destination was named and the send
armed on 2026-09-23; see `docs/BACKUP-EVIDENCE-RECONCILIATION.md` for the
receipts and `docs/CLOUD-READINESS-VERIFICATION.md` for the 22/22 restore from
ciphertext. Treat the commands below as the record of what is running, not as a
draft. The one thing still assumed rather than proven is deletion protection at
the destination — see the CR-4 section of `WINDOW-1-GATE-TABLE.md`.
```

Line 418 ("The nightly dump and the database it was taken from are on the same
disk, in the same machine, in the same room") opens §8's rationale and reads as
history rather than current state, so I would leave it — but it is worth one
read-through in case it lands as a present-tense claim.

## What I am not asking you to change

The **key custody** problem is real and is *not* fixed by any of the above: the
private half is in the keyring on the same host that takes the dumps, so a
compromise or loss of this machine takes the archives' only key with it. That is
gate 8 in `WINDOW-1-GATE-TABLE.md` §B, it is owner-action, and nothing in this
lane has moved any key material. Please do not read "off-host copies work" as
"host loss is survivable" — those two are independent, and only the first is
true today.
