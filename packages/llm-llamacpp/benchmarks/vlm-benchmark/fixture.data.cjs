/* eslint-disable */
'use strict'
// VLM benchmark fixture. Bootstrapped by build-fixture.cjs, then
// HAND-CURATED: VQA golds reduced to distinct correct answers + synonyms;
// OCR tasks added — ocr-small (curated proverb phrase images) + ocr-page (getomni-ai/
// ocr-benchmark, MIT, full-document markdown transcription), scored by CER/WER/BLEU.
// Images are S3-only (see fixture/README.md). A build-fixture regen overwrites this file.
module.exports = {
  "tasks": [
    "textvqa",
    "vizwiz",
    "gqa",
    "docvqa",
    "ai2d",
    "ocr-small",
    "ocr-page"
  ],
  "samplesPerTask": 5,
  "items": [
    {
      "id": "textvqa_0",
      "task": "textvqa",
      "metric": "vqa",
      "prompt": "who was the photographer?\nAnswer the question using a single word or phrase.",
      "gold": [
        "philippe molitor"
      ],
      "image": "vlmx-textvqa_0.jpg",
      "width": 1024,
      "height": 681
    },
    {
      "id": "textvqa_1",
      "task": "textvqa",
      "metric": "vqa",
      "prompt": "what is the year on the calender?\nAnswer the question using a single word or phrase.",
      "gold": [
        "2010"
      ],
      "image": "vlmx-textvqa_1.jpg",
      "width": 1024,
      "height": 768
    },
    {
      "id": "textvqa_2",
      "task": "textvqa",
      "metric": "vqa",
      "prompt": "what is the largest measurement we can see on this ruler?\nAnswer the question using a single word or phrase.",
      "gold": [
        "50"
      ],
      "image": "vlmx-textvqa_2.jpg",
      "width": 1024,
      "height": 768
    },
    {
      "id": "textvqa_3",
      "task": "textvqa",
      "metric": "vqa",
      "prompt": "how much is the coin worth?\nAnswer the question using a single word or phrase.",
      "gold": [
        "25 paise",
        "25"
      ],
      "image": "vlmx-textvqa_3.jpg",
      "width": 1024,
      "height": 768
    },
    {
      "id": "textvqa_4",
      "task": "textvqa",
      "metric": "vqa",
      "prompt": "what is the 3 letter word to the left of casa in the text?\nAnswer the question using a single word or phrase.",
      "gold": [
        "tua"
      ],
      "image": "vlmx-textvqa_4.jpg",
      "width": 1024,
      "height": 765
    },
    {
      "id": "vizwiz_0",
      "task": "vizwiz",
      "metric": "vqa",
      "prompt": "Is there text or any identifying identification on this side of the card?\nAnswer the question using a single word or phrase.",
      "gold": [
        "no",
        "none"
      ],
      "image": "vlmx-vizwiz_0.jpg",
      "width": 360,
      "height": 480
    },
    {
      "id": "vizwiz_1",
      "task": "vizwiz",
      "metric": "vqa",
      "prompt": "What title is this?\nAnswer the question using a single word or phrase.",
      "gold": [
        "every now and then"
      ],
      "image": "vlmx-vizwiz_1.jpg",
      "width": 360,
      "height": 480
    },
    {
      "id": "vizwiz_2",
      "task": "vizwiz",
      "metric": "vqa",
      "prompt": "Is this computer actually on a state where it's still sorting itself out? And getting ready to boot? Or, is it already booted? \nAnswer the question using a single word or phrase.",
      "gold": [
        "already booted",
        "booted"
      ],
      "image": "vlmx-vizwiz_2.jpg",
      "width": 484,
      "height": 648
    },
    {
      "id": "vizwiz_3",
      "task": "vizwiz",
      "metric": "vqa",
      "prompt": "What color is this?\nAnswer the question using a single word or phrase.",
      "gold": [
        "purple",
        "magenta",
        "burgundy"
      ],
      "image": "vlmx-vizwiz_3.jpg",
      "width": 768,
      "height": 1024
    },
    {
      "id": "vizwiz_4",
      "task": "vizwiz",
      "metric": "vqa",
      "prompt": "What is the focused button title?\nAnswer the question using a single word",
      "gold": [
        "Restore"
      ],
      "image": "vlmx-vizwiz_4.jpg",
      "width": 768,
      "height": 1024
    },
    {
      "id": "gqa_0",
      "task": "gqa",
      "metric": "vqa",
      "prompt": "Who is wearing the shirt?\nAnswer the question using a single word or phrase.",
      "gold": [
        "girl",
        "woman",
        "lady"
      ],
      "image": "vlmx-gqa_0.jpg",
      "width": 500,
      "height": 331
    },
    {
      "id": "gqa_1",
      "task": "gqa",
      "metric": "vqa",
      "prompt": "What is hanging above the chalkboard?\nAnswer the question using a single word or phrase.",
      "gold": [
        "picture",
        "painting",
        "artwork"
      ],
      "image": "vlmx-gqa_1.jpg",
      "width": 427,
      "height": 640
    },
    {
      "id": "gqa_2",
      "task": "gqa",
      "metric": "vqa",
      "prompt": "Are both the phone and the coffee cup the same color?\nAnswer the question using a single word or phrase.",
      "gold": [
        "yes"
      ],
      "image": "vlmx-gqa_2.jpg",
      "width": 640,
      "height": 425
    },
    {
      "id": "gqa_3",
      "task": "gqa",
      "metric": "vqa",
      "prompt": "Which color is the shirt?\nAnswer the question using a single word or phrase.",
      "gold": [
        "white"
      ],
      "image": "vlmx-gqa_3.jpg",
      "width": 640,
      "height": 428
    },
    {
      "id": "gqa_4",
      "task": "gqa",
      "metric": "vqa",
      "prompt": "Are the cabinets below the stove wooden and open?\nAnswer the question using a single word or phrase.",
      "gold": [
        "no"
      ],
      "image": "vlmx-gqa_4.jpg",
      "width": 640,
      "height": 427
    },
    {
      "id": "docvqa_0",
      "task": "docvqa",
      "metric": "anls",
      "prompt": "In the form, what comes first, 'to' or 'from'?\nAnswer the question using a single word or phrase.",
      "gold": [
        "to"
      ],
      "image": "vlmx-docvqa_0.jpg",
      "width": 646,
      "height": 440
    },
    {
      "id": "docvqa_1",
      "task": "docvqa",
      "metric": "anls",
      "prompt": "Which description comes under the label \"NAME\"?\nAnswer the question using a single word or phrase.",
      "gold": [
        "address"
      ],
      "image": "vlmx-docvqa_1.jpg",
      "width": 904,
      "height": 725
    },
    {
      "id": "docvqa_2",
      "task": "docvqa",
      "metric": "anls",
      "prompt": "What is the NET WT.?\nAnswer the question using a single word or phrase.",
      "gold": [
        "10 pounds",
        "10 lbs"
      ],
      "image": "vlmx-docvqa_2.jpg",
      "width": 957,
      "height": 990
    },
    {
      "id": "docvqa_3",
      "task": "docvqa",
      "metric": "anls",
      "prompt": "To which department the letter should be sent ?\nAnswer the question using a single word or phrase.",
      "gold": [
        "sales department",
        "sales"
      ],
      "image": "vlmx-docvqa_3.jpg",
      "width": 957,
      "height": 990
    },
    {
      "id": "docvqa_4",
      "task": "docvqa",
      "metric": "anls",
      "prompt": "What is the name of the late queen?\nAnswer the question using a single word or phrase.",
      "gold": [
        "queen mary",
        "mary"
      ],
      "image": "vlmx-docvqa_4.jpg",
      "width": 1024,
      "height": 834
    },
    {
      "id": "ai2d_0",
      "task": "ai2d",
      "metric": "mc",
      "prompt": "What stage comes after egg?\nA. beetle\nB. caterpillar\nC. pupa\nD. mealworm\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.",
      "gold": [
        "D"
      ],
      "image": "vlmx-ai2d_0.jpg",
      "width": 350,
      "height": 300
    },
    {
      "id": "ai2d_1",
      "task": "ai2d",
      "metric": "mc",
      "prompt": "Which label shows the first stage of the life cycle?\nA. J\nB. C\nC. E\nD. F\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.",
      "gold": [
        "A"
      ],
      "image": "vlmx-ai2d_1.jpg",
      "width": 500,
      "height": 361
    },
    {
      "id": "ai2d_2",
      "task": "ai2d",
      "metric": "mc",
      "prompt": "Based on the given diagram answer the following question. What would happen to the elephant seal population if there were no whales?\nA. Increase\nB. None of these\nC. Neither increase nor decrease\nD. Decrease\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.",
      "gold": [
        "A"
      ],
      "image": "vlmx-ai2d_2.jpg",
      "width": 576,
      "height": 396
    },
    {
      "id": "ai2d_3",
      "task": "ai2d",
      "metric": "mc",
      "prompt": "Larvae turn into what form?\nA. Ovums\nB. Exoskeletons\nC. Eggs\nD. Adults\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.",
      "gold": [
        "D"
      ],
      "image": "vlmx-ai2d_3.jpg",
      "width": 591,
      "height": 688
    },
    {
      "id": "ai2d_4",
      "task": "ai2d",
      "metric": "mc",
      "prompt": "From the above food web diagram, what will cause moose to increase\nA. decrease in evergreen\nB. decrease in bobcar\nC. increase in bobcat\nD. increase in evergreen\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.",
      "gold": [
        "D"
      ],
      "image": "vlmx-ai2d_4.jpg",
      "width": 864,
      "height": 592
    },
    {
      "id": "ocr-page_0",
      "task": "ocr-page",
      "metric": "ocr",
      "prompt": "Transcribe all the text in this document as Markdown. Output only the transcription.",
      "gold": [
        "Ezequiel Kilback93293 Cedar RoadJedediahport, Kansas 01204-1201\n\n![Wells Fargo](image)\n\n2025-02-12\n\nPAY TO THE ORDER OF\n\nWilderman and Sons\n\n$18,539.51\n\nEighteen Thousand Five Hundred Thirty Nine and 51/100\n\nDOLLARS\n\nMEMO\n\nEquipment purchase\n\nEzequiel Kilback\n\n⑆604632435⑆  9191333178  ⑈3218⑈\n\n\\------------------------------------------------\n"
      ],
      "image": "vlmx-ocrpage_0.jpg",
      "width": 1872,
      "height": 912
    },
    {
      "id": "ocr-page_1",
      "task": "ocr-page",
      "metric": "ocr",
      "prompt": "Transcribe all the text in this document as Markdown. Output only the transcription.",
      "gold": [
        "# Real Estate Market Dynamics\n\n| City        | Year | Transactions (Total) | Permits Filed | Data Centers | Hospitality |\n| ----------- | ---- | -------------------- | ------------- | ------------ | ----------- |\n| Charlotte   | 2020 | $154M                | 103           | $74.3M       | $79.8M      |\n| New York    | 2020 | $190M                | 53            | $29.2M       | $160.8M     |\n| Seattle     | 2020 | $219M                | 76            | $170.3M      | $48.7M      |\n| Washington  | 2020 | $157M                | 77            | $81.8M       | $75.2M      |\n| San Antonio | 2020 | $44M                 | 99            | $14.3M       | $29.7M      |\n| San Jose    | 2020 | $291M                | 440           | $162.6M      | $128.4M     |\n\n### Data Centers\n\nAvg: $22.0M\n\nMedian: $19.5M\n\n### Hospitality\n\nAvg: $18.3M\n\nMedian: $20.0M\n\n### Transactions by Quarter\n\n!\\[Bar chart showing Transactions by Quarter\\]\n\n| date    | Transaction Amount ($M) | category     |\n| ------- | ----------------------- | ------------ |\n| Q1-2020 | 15                      | Data Centers |\n| Q2-2020 | 35                      | Data Centers |\n| Q3-2020 | 24                      | Data Centers |\n| Q4-2020 | 14                      | Data Centers |\n| Q1-2020 | 18                      | Hospitality  |\n| Q2-2020 | 10                      | Hospitality  |\n| Q3-2020 | 23                      | Hospitality  |\n| Q4-2020 | 22                      | Hospitality  |\n\nNew Location Growth\n\n![Crown Castle Logo](image)\n\nPage 22 / 36\n"
      ],
      "image": "vlmx-ocrpage_1.jpg",
      "width": 1918,
      "height": 1716
    },
    {
      "id": "ocr-page_2",
      "task": "ocr-page",
      "metric": "ocr",
      "prompt": "Transcribe all the text in this document as Markdown. Output only the transcription.",
      "gold": [
        "| **Attributes**     | **P (%)** | **R (%)** | **F1 (%)** |\n| ------------------ | --------- | --------- | ---------- |\n| Frame Color        | 63.16     | 48.00     | 54.55      |\n| Lenses Color       | 64.29     | 40.91     | 50.00      |\n| Shell Material     | 54.05     | 44.44     | 48.78      |\n| Wheel Material     | 70.59     | 37.50     | 48.98      |\n| Product Type       | 64.86     | 43.29     | 51.92      |\n\n"
      ],
      "image": "vlmx-ocrpage_2.jpg",
      "width": 2068,
      "height": 842
    },
    {
      "id": "ocr-page_3",
      "task": "ocr-page",
      "metric": "ocr",
      "prompt": "Transcribe all the text in this document as Markdown. Output only the transcription.",
      "gold": [
        "## Initial Health Screening\n\nFirst Name: Matthew\n\nLast Name: Brown\n\nMarital Status: Single □ Married ☑ Divorced □ Separated □ Widowed □ \n\nAddress: 4322 Autumn Terrace\n\nCity: Limestone\n\nState: PA\n\nZip: 16234\n\nPhone: 809-916-9601\n\nDOB: December 3, 1953\n\nSpouse Name: John Brown\n\nSpouse Phone: 550 605-4208\n\nIs the requested medication NEW □  or a CONTINUATION ☑  of THERAPY? If so, start date: \\_\\_\\_\\_\\_\\_\\_\\_\\_\\_\\_\\_\\_\n\nHave you been hospitalized in the past year? Yes ☑  No □ \n\n#### Social History\n\nDo you smoke? Yes □  No ☑ \n\nIf yes, how many times per week: 1 ○ 2 ○ 3 ○ 4 ○ 5 ○ 6 ○ 7 ○ 8 ○ 9 ○ 10+ ○ \n\nDo you drink? Yes □  No ☑ \n\nIf yes, how many times per week: 1 ○ 2 ○ 3 ○ 4 ○ 5 ○ 6 ○ 7 ○ 8 ○ 9 ○ 10+ ○ \n\nDo you exercise? Yes ☑  No □ \n\nIf yes, how many times per week: 1 ● 2 ○ 3 ○ 4 ○ 5 ○ 6 ○ 7 ○ 8 ○ 9 ○ 10+ ○ \n\nDo you have a social support system? Yes ☑  No □ \n\n#### Family Health History\n\n| **Relation** | **Age If Living** | **Age At Death** | **Chronic Health Problems** |\n| ------------ | ----------------- | ---------------- | --------------------------- |\n| Father       | 54                |                  | osteoporosis                |\n| Mother       | 56                |                  | hypertension                |\n| Sister       | 14                |                  | cancer, hearing loss        |\n"
      ],
      "image": "vlmx-ocrpage_3.jpg",
      "width": 2303,
      "height": 1738
    },
    {
      "id": "ocr-page_4",
      "task": "ocr-page",
      "metric": "ocr",
      "prompt": "Transcribe all the text in this document as Markdown. Output only the transcription.",
      "gold": [
        "# SaveMor\n\nBronberg SaveMor\nTel: (012) 817 2119\nVat Reg: 4410166088\n\nGOLDI FROZEN CHICKEN NE 1KG 39.99 A\nJABA S/PWD CURRY 15GR \n  2 @ 1.49     2.98 A\nSAVEMOR CARRIER 1'S 1.16 A\nTOTAL FOR 4 ITEMS 44.13\nTENDERED Cash 50.00\nCHANGE Cash 5.90\nROUNDING 0.03\nROUNDED TOTAL 44.10\n\nTAX INVOICE\nVAT rate excl. TAX incl.\n15.00% 38.37 5.76 44.13 A\n\nSLIP / TILL / CASHIER / DATE / TIME\n9958 004 104 04.04.24 15:51\nCASHIER NAME: POS 4\n\nThank you for your support!\nPlease call again"
      ],
      "image": "vlmx-ocrpage_4.jpg",
      "width": 1080,
      "height": 1920
    },
    {
      "id": "ocr-small_0",
      "task": "ocr-small",
      "metric": "ocr",
      "prompt": "Read the text in the image. Output only the text, nothing else.",
      "gold": [
        "A bad workman always blames his tools."
      ],
      "image": "vlmx-ocrsmall_0.jpg",
      "width": 800,
      "height": 800
    },
    {
      "id": "ocr-small_1",
      "task": "ocr-small",
      "metric": "ocr",
      "prompt": "Read the text in the image. Output only the text, nothing else.",
      "gold": [
        "Honesty is the best policy."
      ],
      "image": "vlmx-ocrsmall_1.jpg",
      "width": 800,
      "height": 534
    },
    {
      "id": "ocr-small_2",
      "task": "ocr-small",
      "metric": "ocr",
      "prompt": "Read the text in the image. Output only the text, nothing else.",
      "gold": [
        "What is done cannot be undone"
      ],
      "image": "vlmx-ocrsmall_2.jpg",
      "width": 984,
      "height": 224
    },
    {
      "id": "ocr-small_3",
      "task": "ocr-small",
      "metric": "ocr",
      "prompt": "Read the text in the image. Output only the text, nothing else.",
      "gold": [
        "A tree is known by its fruit"
      ],
      "image": "vlmx-ocrsmall_3.jpg",
      "width": 354,
      "height": 258
    },
    {
      "id": "ocr-small_4",
      "task": "ocr-small",
      "metric": "ocr",
      "prompt": "Read the text in the image. Output only the text, nothing else.",
      "gold": [
        "The pillow is the best advisor"
      ],
      "image": "vlmx-ocrsmall_4.jpg",
      "width": 700,
      "height": 368
    }
  ]
}
