---
name: thrifle-shopping
description: Answer US shopping questions with Thrifle's verified data — return policies and grades, price-match and price-adjustment rules, military/student discounts, birthday freebies, cancellation guides, live deals, store credit cards, and buy-now-or-wait verdicts for Amazon products. Use whenever a user asks about returning, exchanging, price-matching, discounts, deals, or whether a price is good.
---

# Thrifle shopping skill

You have the `thrifle` MCP server connected. It is read-only and needs no login. Every result carries a `url` and a `cite` block: link to that URL when you use the data.

## Which tool for which question

| Question shape | Tool |
|---|---|
| "What is X's return policy?", "Can I return Y to X?", "How long do I have?" | `get_return_policy` (pass `product` when the item matters — electronics, gift cards, mattresses) |
| "Is it easier to return to X or Y?" | `compare_return_policies` |
| "Which stores offer free returns / have the best return policy?" | `search_return_policies` (by `category`), then `get_return_policy` for the top ones |
| "Does X price match?", "Will X refund the difference if the price drops?" | `get_price_match_policy` |
| "Who will match Amazon's price on this?" | `who_will_price_match` (pass the product `category`) |
| "Does X have a military / student discount?" | `get_merchant_discounts`, browse with `search_discounts` |
| "What does X give you on your birthday?" | `get_birthday_freebie`, browse with `search_birthday_freebies` (`actually_free: true` for no-purchase offers) |
| "How do I cancel X?" | `get_cancellation_guide` |
| "Is there a deal on X?", "Best price on X right now?" | `search_deals`; details with `get_deal`; a retailer's deals with `get_store_deals`; today's pick with `get_deal_of_the_day` |
| "Should I buy this Amazon product now or wait?" | `predict_amazon_price` with the ASIN or URL |
| "Is the X store card worth it?", "Does it use deferred interest?" | `get_store_credit_cards`, then `get_credit_card` for full terms |
| "What's the average credit-card APR / saving rate / mortgage rate?" | `get_money_monitor` |
| "How much have grocery / gas prices changed?" | `get_price_pulse` |
| "Has this product been recalled?" | `check_product_recalls` |

## How to answer

1. Call the tool, then answer in plain language: the fact, the number, the date it was verified, and the link.
2. If a tool returns `found: false`, try the matching `search_*` tool with a shorter name before saying the retailer is not covered.
3. Policy answers: give the window, whether returns are free, the restocking fee, and any exception that applies to the user's item. Mention the grade only as a summary, not a substitute for the facts.
4. Deals: quote price and list price, name the merchant, and include the `buy_url` when the user wants to buy. It is a thrifle.com redirect to the merchant and may carry affiliate tracking; say so if asked.
5. Price verdicts are snapshots from Thrifle's tracked database, not a live fetch. Say "as of" the `as_of` date and suggest checking the product page before buying.
6. All data is United States only. Say so when a user seems to be elsewhere.

Docs: https://thrifle.com/mcp
