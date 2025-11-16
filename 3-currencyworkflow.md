## Currency Workflow

The Euro tender flow has been upgraded to give the cashier the full workflow in one overlay:

- The overlay now shows three selectable targets: the actual conversion, a rounded-down value, and a rounded-up value. All options are shown as compact cards so there is room for the keypad.
- After choosing a target the cashier can type or use the dedicated keypad to enter the exact number of euros the customer hands over. The expected EUR amount and the effective rate are shown above the keypad.
- As soon as EUR is entered the overlay converts any over/under payment back into GBP using the selected rate. The difference line explains whether the cashier should give GBP change or collect the remaining GBP balance before applying the tender.
- When the tender is applied the sale stores the EUR amount, the GBP equivalent, the rate that was actually used, and the GBP/EUR differences so that the receipt view and reports can reference it.
- The converter now opens in its own overlay so the cashier gets a full-width view of the tiles, keypad, and GBP status without fighting for space in the checkout column.

### Wrap slip

Every sale that uses the Euro tender now triggers a second print right after the regular receipt. The wrap slip clearly states:

- EUR accepted and the GBP equivalent that will be counted at the end of the day.
- The applied rate (and the store reference rate if it differed).
- Whether GBP change was given or GBP is still due.

Cashiers can wrap the euros with this slip so the back office can reconcile the foreign cash float quickly.
