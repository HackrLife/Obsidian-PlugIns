# Citation Snowball

Start from one paper and find the next ones the way a systematic review does: through what it cites and what cites it. Citation Snowball imports papers by DOI, arXiv, PubMed or OpenAlex ID, lists their references (backward snowballing) and the papers that cite them (forward snowballing), and turns the ones you tick into literature notes.

## What it does

- **Imports papers from an identifier.** Paste a DOI, an arXiv ID, a PubMed ID, an OpenAlex ID or a link to any of them. Paste a whole reference list and it finds every identifier in it.
- **Snowballs in both directions.** From any paper, see its full reference list or the papers that cite it, most cited first.
- **Lets you screen before you import.** Filter by title, author or venue, sort by citations or year, read the abstract in place, and tick only the papers that belong in your review.
- **Never imports a paper twice.** Papers already in your vault are marked and skipped, matched on DOI, arXiv, PubMed and OpenAlex IDs in note properties, including notes made by other tools.
- **Keeps the trail.** Every snowballed note links back to the paper it came from, so backlinks and the graph show how your reading grew. A Snowball log note records each search: seed, direction, papers found, already in the vault and imported.
- **Writes notes ready for synthesis.** Each note has properties (authors, year, venue, DOI, citation count, citation key), the abstract, empty Method, Data, Findings and Gaps sections, and an APA 7 reference. The sections match [Literature Matrix](https://community.obsidian.md/plugins/literature-matrix), so imported papers appear in the matrix straight away.

## How to use it

**Import papers.** Run **Import papers** from the command palette, paste one or more identifiers and select Import. Run **Import papers and insert links** from a note to import and link the papers at the cursor. Select a reference list first and it is filled in for you.

**Snowball.** Open a literature note and run **Snowball from the current paper**, or select the snowflake in the ribbon. The plugin reads the note's `doi`, `arxiv`, `pmid` or `openalex` property. To start from a paper you don't have yet, run **Snowball from a DOI or arXiv ID**; the paper is imported first.

The picker opens on the paper's references. Switch to **Cited by** for the papers that cite it, and select **Load more** to page through them. Tick the papers you want and select **Import selected**.

A new note looks like this:

```markdown
---
title: "The Skill Content of Recent Technological Change: An Empirical Exploration"
authors:
  - "David H. Autor"
  - "Frank Levy"
  - "Richard J. Murnane"
year: 2003
venue: "The Quarterly Journal of Economics"
doi: "10.1162/003355303322552801"
openalex: "W2111111"
cited_by: 7000
citekey: "autor2003skill"
snowball_seed: "[[Acemoglu 2002 Technical Change]]"
snowball_direction: reference
tags:
  - paper
---
## Abstract
...
## Method
## Data
## Findings
## Gaps
## Citation
Autor, D. H., Levy, F., & Murnane, R. J. (2003). The skill content ...
```

## Settings

| Setting | What it does |
| --- | --- |
| Folder | Where new literature notes and the Snowball log go. |
| Tag | Added to every imported paper. The default is `paper`. |
| File name | Built from `{{title}}`, `{{author}}`, `{{year}}` and `{{citekey}}`. |
| Open the note after a single import | Opens the new note when you import one paper. |
| Sections | Empty headings added to new notes. The default is `Method, Data, Findings, Gaps`. |
| Include the abstract | Adds the abstract under its own heading. |
| Template note | Optional note to use as the body instead. Placeholders: `{{title}}`, `{{authors}}`, `{{year}}`, `{{venue}}`, `{{doi}}`, `{{arxiv}}`, `{{url}}`, `{{pdf}}`, `{{abstract}}`, `{{citation}}`, `{{citekey}}`, `{{cited_by}}`. Properties are always added. |
| Keep a snowball log | Records every snowball search in a Snowball log note. |
| OpenAlex API key | Optional. See below. |
| Contact email | Optional. Sent to Crossref with fallback lookups. |

## Data sources and network use

This plugin needs the internet. It sends paper identifiers, and nothing from your notes, to these services:

- [OpenAlex](https://openalex.org) for paper details, reference lists and citing papers.
- [Crossref](https://www.crossref.org) when OpenAlex doesn't know a DOI.
- [arXiv](https://arxiv.org) when OpenAlex doesn't know an arXiv ID.

Looking up a single paper is free and unlimited on OpenAlex. Listing references and citing papers draws on a small daily allowance, which a free [OpenAlex API key](https://openalex.org/settings/api) raises tenfold. Paste the key into the settings if you snowball often. The key is stored in this plugin's settings file in your vault and is only sent to OpenAlex.

Reference lists come from OpenAlex and are as complete as the publisher's deposit. Some papers, especially preprints, have none.

## Install

Search for **Citation Snowball** in **Settings → Community plugins → Browse**, then select Install and Enable.

To install by hand, download `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/citation-snowball/`, then enable the plugin in Settings.

## Build from source

```bash
npm install
npm run build
```

## License

MIT © Dev Das
