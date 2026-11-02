ALPHADOME WORKER — read this first
===============================

What this is
  A small program that runs on THIS computer, because your MoreLogin profile
  lives here. When you press "Capture now" in the Alphadome portal, this
  program does the browser work on your machine and sends the results back.

  Your Alphadome portal cannot reach this computer. That is on purpose: your
  MoreLogin profile has no password on its local debug port, so letting the
  internet reach it would let anyone who found the address drive your
  signed-in accounts. So the work comes to the profile, not the other way.

What you need (once)
  1. MoreLogin installed and open on this computer, with your profile created.
  2. You have signed in to Micro1 / Turing *inside* that MoreLogin profile.
  3. Node.js. If you do not have it, the start file will tell you and give
     you the link: https://nodejs.org  (choose LTS, click Next through it).

How to start it
  Windows:  double-click   "Start Worker.cmd"
  Mac/Linux: run           ./start-worker.sh

  The first time it asks for your worker token. You get that from the
  Alphadome portal:  Your own browser  ->  Create worker token.
  It is shown ONCE. Copy it, paste it into this window, press Enter.

  It is saved as worker-token.txt in this folder so you only paste it once.
  Keep this folder to yourself — that file is the key to your worker.

Leave the window open
  Captures only run while the worker window is open. Closing it is safe, it
  just means a queued capture waits until you open it again.

  In the portal, the panel shows either
      "last seen <time>"   -> your computer is connected and listening
      "never connected"    -> the worker has not checked in yet

What it never does
  - It never sees or stores a marketplace password. Nothing to see: you signed
    in yourself, in your own browser profile.
  - It never writes to Alphadome's database. It sends what it saw to the
    portal, and the portal decides what to save.
  - It only acts on runs queued for YOUR account. The token in that file
    cannot reach anyone else's.

Stopping and removing
  Stop:   close the window (or press Ctrl+C).
  Remove: delete this whole folder. Then, in the portal, press
          "Revoke" under the worker token so the old token stops working.

If something goes wrong
  "token rejected"        The token was revoked or mistyped. Create a new one
                          in the portal (Revoke the old one first), delete
                          worker-token.txt, start again.
  "profile not ready"     Open MoreLogin and make sure the profile is not
                          already running, then try again.
  "daily startup limit"   Your MoreLogin plan allows a limited number of
                          profile starts per day. Wait for the reset, or
                          upgrade the plan.
  "api key" in a message  Some MoreLogin installs ask for the API key when a
                          profile is started from the command line. Your key
                          deliberately stays on the Alphadome server, so send
                          us that line and we will sort it out rather than ask
                          you to put the key on this machine.
  Anything else: copy the last few lines of the window and send them to us.

Where the token lives
  In this folder, as worker-token.txt. It is a credential, so: do not email it,
  do not put it in a shared drive, and do not copy this folder to another
  person's computer. Revoking it in the portal switches it off for good.
