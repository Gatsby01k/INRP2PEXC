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
| First press in the converter | A smile and a soft pulse of the antenna (from rest only) | It acknowledges that the visitor has started |
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
| Returns to the tab after 6 s away | Two quick blinks to refocus, then a smile | It welcomes them back |
| Mouse leaves through the top of the window | **Puppy eyes**: wide, inner lids raised, a look up at where the mouse left | A soft "don't go" |
| …the mouse comes back | It smiles with relief | It is glad they stayed |
| Left alone for 16 s | Today's rate runs across the visor | Useful while they think |
| Left alone for 40 s | **It dozes off**: the lids droop, it nods once and catches itself, then the eyes close, Z's float up, and the antenna and ears dim | It is quietly waiting for them, with some charm |
| Any move while it sleeps | **Startled awake**: the eyes snap wide, a hop, a double blink, then `^ ^` | Coming back is rewarded |
| Taps or clicks the robot | **Giggles**: `^ ^` eyes with a blush, a jiggle, a little hop. Three taps in a row get hearts | Curiosity is rewarded. Never blocks a tap (the stage takes no pointer events) |
| Mouse rests on the robot's head | **Content**: closed happy eyes with a blush, the head leans into the pointer | It enjoys a pat |
| At rest (every 9 to 15 s, irregular) | Reading the headline, a glance at the converter with a nod, or now and then a small hop. Never a wink, never a wave | It stays alive without fidgeting |

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
- **One wave, on arrival.** The robot waves only when it first comes online. Every other hello is a smile.
- **No visible start-up**: the live robot draws behind the still one until its frames are smooth, and only then takes
  over and says hello, so nobody sees it stutter into life.
- **No cost when nobody looks**: the robot does not draw off screen. Presence is a handful of passive listeners
  that store a timestamp. Nothing on the first screen fades in from opacity 0.
- **The workspace is unchanged**: its moods (`waiting`, `focused`, `ready`, `alert`, `success`, …) outrank everything
  here. The robot sleeps, gets poked and welcomes people back only on the home page (mood `none`).
