# Security

Please don't report a security problem in a public issue. Use GitHub's private reporting instead: the
repository's **Security** tab, then **Report a vulnerability**. We'll reply there.

## What Swarmbox is for, and isn't

- It runs throwaway copies of your product on your own machine, with invented data and fake outside
  services. Never point it at production, real customer data or real provider accounts.
- It signs people in without a password by minting sessions through your product's own code. That is safe
  only because the world is local and throwaway; an adapter must never do this against a shared or
  deployed environment.
- The MCP server and the control room listen on 127.0.0.1 only and have no sign-in of their own: anyone
  who can reach those ports on your machine can drive the screens. Don't expose them.
- A product's sandbox hooks (`/_sandbox`) take a bearer token per world; keep them off in anything but a
  sandbox world.
