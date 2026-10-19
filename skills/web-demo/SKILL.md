---
name: web-demo
description: A demo of a web product (a site, a web app, a dashboard) filmed from the live product by a list of steps, so it can be filmed again after the product changes and the film keeps its edit. Use when the person wants a product demo, feature video, walkthrough or tutorial of something that runs in a browser and gives its address rather than a recording, or wants a demo they can refresh after every release (网页产品演示, 录网站, 改版后重录).
---

# Web demo

Make the demo that shows this product at its best as it is today, and that stays true: when the product changes, the
same steps film it again and the cut follows. The viewer always knows where to look, sees each step land, never
waits, and could do the same in the product right now.

## What defines it

Every shot of the product is a take filmed from steps that can run again. A screen recording made by hand is a screen
demo, not this: what this film offers the person is that the next release costs them one command, not a new edit.

## What has to be true

- **The real product.** Its own pages, data and results, filmed from its live address; never a redrawn interface, a
  mockup, or a result that did not happen.
- **It films again.** Every recording in the film is a take with its record beside it, and every clip of a take starts
  inside a step or a mark, so after `again` each clip keeps its place and its length. Run `again` once before you
  finish: the film it gives must still be right, and every clip it lists is fixed.
- **Nothing private in any frame**: keys, tokens, passwords, emails, names, customer data and notifications are
  hidden, or the take is filmed with a demo account. Steps are saved in plain text beside the video, so a real
  password never goes in them.
- **Readable where it is watched**: the action, its text and its result readable at the size the film is made for, on
  a phone too when it is vertical.
- **Honest time.** A take leaves out the waiting (`idle`, `until`). Where speed is what the product sells, the real
  time stays or the film says it was shortened.

## What you have

`node <this skill's folder>/scripts/record.mjs` films a take in the person's own Chrome or Edge: from an address and a
list of steps it writes the video, its record (what to film, and when each step and mark happened) and a page that
draws the pointer and its clicks, laid over the video with the same `at`, `#t=` and box; a page plays at one speed, so
a take meant to change speed is filmed with the pointer drawn into it (`--pointer`). It also writes a camera page: the
take moving in on each click and following the typing after it, the pointer drawn in, used in place of the video in
film.html with the same `#t=`; how far it moves in is set for the take or for one step, and `camera` writes it again
without filming. `again` films a take again from its record and moves its clips in film.html; `inspect` lists what can
be pointed at on a page, before or after some steps, with a selector for each. `--help` says how. The page runs on a
virtual clock, one frame at a time, so a slow machine gives a smooth take and the same steps give the same motion. A
take costs six to seven times its length at the default scale: film one shot per take.

A take is a recording like any other, a clip of the film: trimmed with `#t=`, sped up with `speed`, never re-encoded;
a page can play it silent with its time set from t when the picture should move over it. `look` checks the film, `get`
brings voice, music and sound; and anything you can make pictures and motion with.

## With the person

What they ask for comes before anything here. Ask for the address, a demo account when the product needs signing in,
who the demo is for and the one thing it must show; ask without holding up the work. When done, tell them in a few
lines what it shows, what was left out or hidden, which takes make it, and the command that films it again after
their next release.
