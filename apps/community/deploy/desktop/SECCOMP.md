# Chromium seccomp profile provenance

`seccomp-docker-default-245180c.json` is the unmodified Docker/Moby profile fetched from:

`https://raw.githubusercontent.com/moby/profiles/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json`

The upstream repository commit is `245180c51918481c0525424b3ee025d2b435d46c` and the source file SHA-256 is:

`785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`

`seccomp-chromium.json` is that exact source profile with one rule inserted at the beginning of `syscalls`:

```json
{
  "names": ["clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root", "chroot"],
  "action": "SCMP_ACT_ALLOW",
  "comment": "Chromium sandbox namespace setup"
}
```

The derived profile SHA-256 is `b0de18075739bb287cfd754d6dbfba6019d80387b1b710c7cb702dd2dfd8fac`. The rule is required on the tested Oracle Linux 9.8 ARM64 host because the stock profile caused Chromium’s sandbox zygote to fail with `Operation not permitted`. The container still runs as UID 10001, drops every capability, and uses `no-new-privileges`; this profile must remain scoped to this desktop container and must not be replaced with `seccomp=unconfined`.
