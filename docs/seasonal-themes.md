# Seasonal themes

The home page decorates itself by the calendar. Nobody deploys to put a season
up and nobody deploys to take it down — which is the point, because the person
who would have to remember is busy running a plant.

Only `index.html` loads it. The forms carry injury reports, food safety reports
and FMLA leave requests; a screen someone uses to report an injury is not a
screen to decorate. A test enforces that.

## The calendar

Windows live in `SEASONS` at the top of `seasonal.js`. Months are zero-based,
because that is what `Date.getMonth()` returns.

| Season | Window | Still ornament | Animation |
|---|---|---|---|
| St Patrick's | 1–17 March | Shamrock | Shamrocks falling and spinning |
| Fiesta San Antonio | 15–30 April | Papel picado pennant | Confetti falling |
| Pride | 1–30 June | Rainbow pennant, plus a flag band across the top of the page | Hearts rising |
| Halloween | 8 September – 31 October | Spider and cobwebs | Bats crossing |
| Thanksgiving | 1–30 November | Two autumn leaves | Leaves falling and tumbling |
| Christmas | 1–31 December | Bauble | Snow falling |

January, February, May, July, August and the first week of September are a
plain portal.

Two windows worth a second look each year:

- **Fiesta moves.** The actual dates change annually — 2026 runs 16–26 April —
  so the window is deliberately wider than any one year's parade schedule. If a
  year falls outside 15–30 April, move it.
- **Halloween starts in September.** It was widened to 8 September so the theme
  could be seen the week it shipped, and it has stayed there. Narrowing it to
  October is a one-line edit and nothing else has to change.

## Changing a window

Edit the `from` and `to` pair. Nothing else. The tests read the calendar out of
`seasonal.js` rather than hardcoding dates, so moving a window is an ordinary
edit and not a build failure — they probe whatever edges they find.

Windows must not overlap. `seasonal.js` stops at the first match, so an overlap
would silently swallow a season instead of failing; a test rejects one.

## Adding a season

Four pieces, all next to the ones already there:

1. An entry in `SEASONS` in `seasonal.js`.
2. A `.flock-<name>` block of flyers and a `.hanger-<name>` ornament in the
   markup of `index.html`.
3. A block of CSS in the seasonal section of `index.html`.
4. A `.notice-<name>` in both languages.

Two rules the tests enforce, both of them lessons rather than preferences:

- **Every season needs a still ornament.** Flyers do not render at all under
  `prefers-reduced-motion`, and in every other case `seasonal.js` removes them
  after one pass — so a season built only of flyers is blank most of the time.
  That is not hypothetical: for a month, a phone showed nothing seasonal at all
  after the animation had run.
- **`flight` must outlast the last flyer.** Take the last one's delay, add its
  duration, leave slack. Halloween shipped 3.8 seconds short and the last bat
  vanished in mid-air. A test now reads the real numbers back out of the CSS and
  the markup and rejects a short one.

## Why the animations end

The portal runs on a shared floor kiosk that stays open all shift. An animation
left looping there composites for hours in front of nobody. Every flight is
finite and then removes itself from the document; what is left is the still
ornament, which is one element and one slow transform.

The flyers also wait for the coming-soon dialog to be dismissed before they
launch, so the one animation an employee is meant to see is not over before they
have seen it.

## Turning it off

Delete `seasonal.js`, its `<script>` tag, the seasonal CSS block and the
decoration markup. There is nothing else to unpick — no build step, no
dependency, no stored state.
