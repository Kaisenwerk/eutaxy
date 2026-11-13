# object-unit-twice-across-objects

**The bug.** A cart object takes a unit of an item from the item's shelf,
another object, which it calls through its own `env`, and keeps the item
once the shelf has answered. The shelf gives a unit for every call. When
a take was made and the cart did not get to keep the item (the shelf's
answer was lost on its way back, or the cart was reset right after the
call), the cart's caller sends its request again, the cart asks again,
and the shelf gives the same cart a second unit.

**Why it matters.** The two writes are in two objects with no transaction
across them, and the window between them is the call from one object into
the other, where no request-level test reaches: seen from outside, every
request either answers or fails. It is only reachable when the call an
object makes through its own binding is something a fault can land on,
which is what the model makes it: an effect of the call the cart is
serving, hosting what the shelf does.

**What Eutaxy must report.** `VIOLATED` on `one-unit-a-cart`, with one
fault on `DO:SHELF take`, the cart's own call, and both takes made by the
cart: one in the request, one in its resend. Seeded and exhaustive
exploration both find it. With `FixedShelf` the scenario is `BOUNDED`,
seeded and exhaustively.

**The fix.** Make the take one that can be made twice: the shelf keys it
by the cart, so a cart that asks again is given the unit it has. The
window is still there, and a resend still crosses it, but crossing it
gives nothing.
