# inventory-oversell-sqlite

**The bug.** A Durable Object inventory keeps its stock in a SQLite table
(`ctx.storage.sql`). A reservation reads the SKU's quantity, holds the
unit with the warehouse through an external API, then decrements the row.
The input gate holds other events only while the object waits on its own
storage, not while it awaits an outbound `fetch`, so a second reservation
runs while the first awaits the warehouse, reads the same quantity of 1,
passes the check and holds a unit too. Both decrement, and the stock ends
at -1.

**Why it matters.** The SQL statements are each atomic and synchronous;
the race is between the object's outbound call and another call into the
object. It is the wallet's race on SQL storage, which v0.13 seeds and
snapshots table by table: the invariant reads the `stock` table of the
object `store-1` as rows.

**What Eutaxy must report.** `VIOLATED` on `stock-never-negative` with no
fault, and a trace in which the second `reserve` call starts before the
first one's hold returns. The fixed inventory (`FixedInventory`), which
takes the stock in one guarded `UPDATE` before holding, is `BOUNDED` with
two in flight.

**The fix.** Decrement first, in one statement guarded by the stock
(`WHERE sku = ? AND qty >= ?`), and hold with the warehouse only when a
row changed, giving the unit back if the hold fails.
