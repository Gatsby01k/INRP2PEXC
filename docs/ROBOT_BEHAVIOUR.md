# The robot on the home page: behaviour design

The robot is INRP2P's escrow with a face. On the home page it does one job: it pays attention to the visitor and
answers what they do, so the page feels attended to and the next step is obvious. It is never decoration that loops.
Each reaction below has a trigger the visitor caused, a purpose, and an end. The robot then goes back to rest.

Two channels, and they take turns, never at once:

- **The face**: eyes, lids, hearts, stars, blush, Z's, plus head, body, arms and antenna. This is where emotion shows.
- **The visor's words** (LED display, `director.ts`): amounts, ₹, SELL/BUY, `→`. This is where facts show. Words
  cover the eyes, so they wait while an emotion is on the face, and an emotion never plays under words.

## The moments

| When | What the robot does | Why |
| --- | --- | --- |
| The live robot arrives | The emblem sweeps, then it waves with `^ ^` eyes. Its visor says `HI!` | It shows the robot is alive and says hello |
| First press in the converter | A wave and a smile (from rest only) | It acknowledges that the visitor has started |
| Typing an amount | Eyes on the field, narrowed, a band of light reads each change. The amount echoes on the visor | It is reading their number |
| Amount settles, under 250K | It nods with pleased arches. Then the ₹ estimate runs across the visor | It confirms the amount, then gives the fact |
| 250K up to 1M | Round eyes with an `o` mouth, chin up, one hop, the antenna lit | It noticed a big deal |
| 1M and over | **Star eyes** that twinkle, two hops, the antenna flashes | A whale is welcome |
| Buy ⇄ Sell | A hop, a glance at the switch, `SELL` or `BUY` on the visor | It shows the new direction |
| Asks for a price with no amount | It shakes its head, looks concerned at the field, `?` | It points at what is missing |
| Pointer on the call to action | It leans in, smiling, with `→` on the visor | It nudges the click |
| …held there for about 2 seconds | The arrow gives way to **hearts** and a small bounce | The visitor is hesitating, so it shows affection |
| Presses the call to action | **Hearts beat, both arms up, a bounce** | It rewards the decision. The last thing seen is delight |
| Scrolls down past the robot | It **looks down after the visitor**, curious, leaning a little | "Read on, I'm following" |
| Comes back to the top after reading | **Welcome back**: `^ ^`, a hop, then a look at the amount field and `→` (`↓` on a phone) | It leads the returning reader to the converter |
| Returns to the tab after 6 s away | Two quick blinks to refocus, then a wave and a smile | It welcomes them back |
| Mouse leaves through the top of the window | **Puppy eyes**: wide, inner lids raised, a look up at where the mouse left | A soft "don't go" |
| …the mouse comes back | It smiles with relief | It is glad they stayed |
| Left alone for 16 s | Today's rate runs across the visor | Useful while they think |
| Left alone for 40 s | **It dozes off**: the lids droop, it nods once and catches itself, then the eyes close, Z's float up, and the antenna and ears dim | It is quietly waiting for them, with some charm |
| Any move while it sleeps | **Startled awake**: the eyes snap wide, a hop, a double blink, then `^ ^` and `HI!` | Coming back is rewarded |
| Taps or clicks the robot | **Giggles**: `^ ^` eyes with a blush, a jiggle, a little hop. Three taps in a row get hearts | Curiosity is rewarded. Never blocks a tap (the stage takes no pointer events) |
| Mouse rests on the robot's head | **Content**: closed happy eyes with a blush, the head leans into the pointer | It enjoys a pat |
| At rest (every 4.5 to 8.5 s, irregular) | A wink, reading the headline, a glance at the converter with a nod, a hop, or a wave | It stays alive without repeating on a beat |

Lower on the page the same robot appears as stills with LED visors. They keep their own stories (the deal's display,
the trader's margin). The closing robot answers the closing call to action the way the hero robot answers its own:
**hearts on its visor while the button is hovered or focused**, and `Your move →` otherwise.

## Rules

- **Reduced motion**: there is no live robot, no visor director and no presence tracking. The still image stays
  still. The closing visor swaps its words without motion.
- **A weak GPU, a phone with little memory, or a slow connection**: the still robot (`liveRobotAllowed`,
  `governor.ts`), unchanged. Its LED overlay carries the same moments in words: `♥ ♥` for the call to action,
  `Z Z` while asleep, `HI!` on waking.
- **Never blocks a tap**: the stage keeps `pointer-events: none`. Taps on the robot are read from the window,
  passively, and only when they land on the robot's own box.
- **No cost when nobody looks**: the robot does not draw off screen. Presence is a handful of passive listeners
  that store a timestamp. Nothing on the first screen fades in from opacity 0.
- **The workspace is unchanged**: its moods (`waiting`, `focused`, `ready`, `alert`, `success`, …) outrank everything
  here. The robot sleeps, gets poked and welcomes people back only on the home page (mood `none`).

## The robot in the workspace (ADR 0034)

Inside the workspace the same character is INRP2P's front line: a small head in the masthead on every page, its face on the
visor in LEDs. It never pops up and never speaks unasked; it makes a face and, when it has something new, lights its antenna.

| When | Its face | What it says when opened |
| --- | --- | --- |
| A deal waits on the person | wide eyes | "Your move: pay INR" — the deal, its time, one tap to it |
| A price waits for their yes | stars | "I found you a price — held until 14:32 IST" |
| It is searching for a trader | three dots, one after another | "Finding a trader for 2,000 USDT" — who is online, where it will tell them |
| A deal is moving without them | calm | "IX-… is moving — nothing needed from you" |
| A step on their way in | a glance towards the page | the step, why it matters now, one action; "Not now" rests it for a week |
| A trader is offline | a sleeping "z" | "You are offline" |
| Traded before, away a while (and asked to hear) | hearts | today's market against their last deal |
| Nothing pressing | calm, an irregular blink | today's market; what it remembers |
| The person did something on the page (a request sent, a price locked) | `^ ^` and one hop | — |
| Something on the page needs fixing | wide, a double blink | — |

Opened, it also says what it is doing for them meanwhile, what it remembers (its last message, their last deal, the desk's
answer to their question), takes a question, and lets them choose what it may send outside the app.

Rules: every motion is CSS on the eyes and antenna only; reduced motion stills them. No WebGL and no image: a few vector
shapes, drawn on the server, so the first paint never waits for it; its words arrive after the page (`/api/client/robot`).

### The robot at the client's side (addendum, 2026-11-28)

The masthead head alone was not enough: a client had to find it. So the big robot on every stage now **speaks** — a white
remark beside it, in the first person, at most two sentences (three for the first hello), every figure one of record
(`_robot/speech.ts`, pure, unit-tested). Under the remark, where it is working, its visor's log: black glass, the times
in the mark's orange, the step in progress blinking — the deal's own record (stops reached, the transfer seen on TRON, the
payment filed), or the wait's (when it started, how many traders were told, how many are online, the place in line).

| Where | What it says |
| --- | --- |
| Exchange, first visit | "Hi, I'm the INRP2P robot." · one firm price for all of it · every deal runs through escrow — once per browser |
| Exchange, traded before | "Last time you sold 1,000 USDT at ₹96.40. Today the market is ₹97.10." — **Same again** prefills the form |
| Being priced / waiting | what it is doing about it, when the price lands, where it will tell them; the wait's log |
| A firm quote (desk only) | one firm price for the whole amount, held until HH:MM, nothing moves until they accept |
| Seller, escrow | it watches TRON for the exact amount; locked the moment it lands, released only on their word |
| Buyer, escrow | the seller is locking it — **don't pay anything yet** |
| Buyer, paying | the seller's USDT is locked, so it is safe to pay now |
| Seller, "Did ₹… arrive?" | **open your bank app** and find it from the buyer's own account — screenshots and SMS can be faked |
| Last five minutes of the client's own step | calmly: what to do if it is done, and what happens if it is not |
| Payer name not the buyer's (ADR 0030) | what that means and that the escrow stays locked — never what INRP2P decides |
| A phone, WhatsApp, Telegram, an email or a handle in the deal chat | keep it here: off INRP2P the escrow cannot protect you — under the other side's message, or over the person's own draft |
| "Cancel" in the deal chat | if money moved, don't — tap Support while the escrow stays locked |
| Done / closed | thanks, the receipt, **Same again** |
| Bank & wallets · Account · Open account | what they can do with what they added and the one thing to add next; where it messages them; what happens when the account opens |

Rules kept: no popups and nothing opens by itself; one remark at a time (it arrives again only when what it says
changes); no sound; never guilt, sirens or invented figures; never a word on a dispute's outcome or a release. On a
phone the firm quote is a decision against the clock, so the robot is quiet there; the log keeps to the last thing done
and the thing in progress. **Ask me** on a stage opens the masthead robot's conversation with the question box focused.
