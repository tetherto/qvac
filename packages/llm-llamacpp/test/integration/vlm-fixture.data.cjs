'use strict'
// QVAC-19178: frozen 5-task x 5-sample VLM benchmark fixture (auto-generated, FLAT).
// images: media/vlmx-*.png (desktop) and test/mobile/testAssets/vlmx-*.png (mobile).
module.exports = {
  tasks: ["vqav2", "textvqa", "docvqa", "chartqa", "scienceqa"],
  samplesPerTask: 5,
  items: [
  {
    "id": "vqav2_0",
    "task": "vqav2",
    "metric": "vqa",
    "prompt": "Where is he looking?\nAnswer the question using a single word or phrase.",
    "gold": [
      "down",
      "down",
      "at table",
      "skateboard",
      "down",
      "table",
      "down",
      "down",
      "down",
      "down"
    ],
    "image": "vlmx-vqav2_0.png"
  },
  {
    "id": "vqav2_1",
    "task": "vqav2",
    "metric": "vqa",
    "prompt": "What are the people in the background doing?\nAnswer the question using a single word or phrase.",
    "gold": [
      "spectating",
      "watching",
      "watching",
      "watching",
      "watching",
      "watching",
      "watching",
      "watching",
      "watching",
      "watching"
    ],
    "image": "vlmx-vqav2_1.png"
  },
  {
    "id": "vqav2_2",
    "task": "vqav2",
    "metric": "vqa",
    "prompt": "What is he on top of?\nAnswer the question using a single word or phrase.",
    "gold": [
      "table",
      "table",
      "table",
      "picnic table",
      "picnic table",
      "picnic table",
      "picnic table",
      "picnic table",
      "skateboard",
      "picnic table"
    ],
    "image": "vlmx-vqav2_2.png"
  },
  {
    "id": "vqav2_3",
    "task": "vqav2",
    "metric": "vqa",
    "prompt": "What website copyrighted the picture?\nAnswer the question using a single word or phrase.",
    "gold": [
      "foodiebakercom",
      "foodiebakercom",
      "foodiebaker",
      "foodiebakercom",
      "foodiebakercom",
      "http://foodiebakercom",
      "foodiebakercom",
      "foodiebakercom",
      "foodiebakercom",
      "foodiebaker"
    ],
    "image": "vlmx-vqav2_3.png"
  },
  {
    "id": "vqav2_4",
    "task": "vqav2",
    "metric": "vqa",
    "prompt": "Is this a creamy soup?\nAnswer the question using a single word or phrase.",
    "gold": [
      "no",
      "no",
      "no",
      "no",
      "no",
      "no",
      "no",
      "no",
      "no",
      "no"
    ],
    "image": "vlmx-vqav2_4.png"
  },
  {
    "id": "textvqa_0",
    "task": "textvqa",
    "metric": "vqa",
    "prompt": "what is the brand of this camera?\nAnswer the question using a single word or phrase.",
    "gold": [
      "nous les gosses",
      "dakota",
      "clos culombu",
      "dakota digital",
      "dakota",
      "dakota",
      "dakota digital",
      "dakota digital",
      "dakota",
      "dakota"
    ],
    "image": "vlmx-textvqa_0.png"
  },
  {
    "id": "textvqa_1",
    "task": "textvqa",
    "metric": "vqa",
    "prompt": "what does the small white text spell?\nAnswer the question using a single word or phrase.",
    "gold": [
      "copenhagen",
      "copenhagen",
      "copenhagen",
      "copenhagen",
      "copenhagen",
      "thursday",
      "copenhagen",
      "copenhagen",
      "copenhagen",
      "copenhagen"
    ],
    "image": "vlmx-textvqa_1.png"
  },
  {
    "id": "textvqa_2",
    "task": "textvqa",
    "metric": "vqa",
    "prompt": "what kind of beer is this?\nAnswer the question using a single word or phrase.",
    "gold": [
      "ale",
      "sublimely self-righteous ale",
      "stone",
      "ale",
      "self righteous",
      "ale",
      "ale",
      "ale",
      "ale",
      "ale"
    ],
    "image": "vlmx-textvqa_2.png"
  },
  {
    "id": "textvqa_3",
    "task": "textvqa",
    "metric": "vqa",
    "prompt": "what brand liquor is on the right?\nAnswer the question using a single word or phrase.",
    "gold": [
      "bowmore ",
      "bowmore",
      "bowmore",
      "bowmore",
      "bowmore",
      "bowmore",
      "bowmore",
      "bowmore islay",
      "dowmore islay",
      "bowmore islay"
    ],
    "image": "vlmx-textvqa_3.png"
  },
  {
    "id": "textvqa_4",
    "task": "textvqa",
    "metric": "vqa",
    "prompt": "how long has the drink on the right been aged?\nAnswer the question using a single word or phrase.",
    "gold": [
      "10 years",
      "10 year",
      "10 years",
      "10 years ",
      "10 years",
      "10 years",
      "10 years",
      "10 years",
      "martial arts",
      "10"
    ],
    "image": "vlmx-textvqa_4.png"
  },
  {
    "id": "docvqa_0",
    "task": "docvqa",
    "metric": "anls",
    "prompt": "What is the ‘actual’ value per 1000, during the year 1975?\nAnswer the question using a single word or phrase.",
    "gold": [
      "0.28"
    ],
    "image": "vlmx-docvqa_0.png"
  },
  {
    "id": "docvqa_1",
    "task": "docvqa",
    "metric": "anls",
    "prompt": "What is name of university?\nAnswer the question using a single word or phrase.",
    "gold": [
      "university of california",
      "University of California",
      "university of california, san diego"
    ],
    "image": "vlmx-docvqa_1.png"
  },
  {
    "id": "docvqa_2",
    "task": "docvqa",
    "metric": "anls",
    "prompt": "What is the name of the company?\nAnswer the question using a single word or phrase.",
    "gold": [
      "itc limited",
      "ITC Limited"
    ],
    "image": "vlmx-docvqa_2.png"
  },
  {
    "id": "docvqa_3",
    "task": "docvqa",
    "metric": "anls",
    "prompt": "Where is the university located ?\nAnswer the question using a single word or phrase.",
    "gold": [
      "san diego",
      "San Diego"
    ],
    "image": "vlmx-docvqa_3.png"
  },
  {
    "id": "docvqa_4",
    "task": "docvqa",
    "metric": "anls",
    "prompt": "To whom is the document sent?\nAnswer the question using a single word or phrase.",
    "gold": [
      "Paul"
    ],
    "image": "vlmx-docvqa_4.png"
  },
  {
    "id": "chartqa_0",
    "task": "chartqa",
    "metric": "relaxed",
    "prompt": "How many food item is shown in the bar graph?\nAnswer the question using a single word or phrase.",
    "gold": [
      "14"
    ],
    "image": "vlmx-chartqa_0.png"
  },
  {
    "id": "chartqa_1",
    "task": "chartqa",
    "metric": "relaxed",
    "prompt": "What is the difference in value between Lamb and Corn?\nAnswer the question using a single word or phrase.",
    "gold": [
      "0.57"
    ],
    "image": "vlmx-chartqa_1.png"
  },
  {
    "id": "chartqa_2",
    "task": "chartqa",
    "metric": "relaxed",
    "prompt": "How many bars are shown in the chart?\nAnswer the question using a single word or phrase.",
    "gold": [
      "3"
    ],
    "image": "vlmx-chartqa_2.png"
  },
  {
    "id": "chartqa_3",
    "task": "chartqa",
    "metric": "relaxed",
    "prompt": "Is the sum value of Madagascar more then Fiji?\nAnswer the question using a single word or phrase.",
    "gold": [
      "No"
    ],
    "image": "vlmx-chartqa_3.png"
  },
  {
    "id": "chartqa_4",
    "task": "chartqa",
    "metric": "relaxed",
    "prompt": "What's the value of the lowest bar?\nAnswer the question using a single word or phrase.",
    "gold": [
      "23"
    ],
    "image": "vlmx-chartqa_4.png"
  },
  {
    "id": "scienceqa_0",
    "task": "scienceqa",
    "metric": "mc",
    "prompt": "Which animal's mouth is also adapted for bottom feeding?\nContext: Sturgeons eat invertebrates, plants, and small fish. They are bottom feeders. Bottom feeders find their food at the bottom of rivers, lakes, and the ocean.\nThe 's mouth is located on the underside of its head and points downward. Its mouth is adapted for bottom feeding.\nFigure: sturgeon.\nA. discus\nB. armored catfish\nAnswer with the option's letter from the given choices directly.",
    "gold": [
      "B"
    ],
    "image": "vlmx-scienceqa_0.png"
  },
  {
    "id": "scienceqa_1",
    "task": "scienceqa",
    "metric": "mc",
    "prompt": "Which of the following could Wendy's test show?\nContext: People can use the engineering-design process to develop solutions to problems. One step in the process is testing if a potential solution meets the requirements of the design.\nThe passage below describes how the engineering-design process was used to test a solution to a problem. Read the passage. Then answer the question below.\n\nPeople with diabetes sometimes take a medicine made from insulin. Insulin can be made by a special type of bacteria. Wendy was a bioengineer who wanted to increase the amount of insulin that the bacteria produced by 20%. She read that giving the bacteria more nutrients could affect the amount of insulin they produced. So, Wendy gave extra nutrients to some of the bacteria. Then, she measured how much insulin those bacteria produced compared to bacteria that did not get extra nutrients.\nFigure: studying bacteria in a laboratory.\nA. whether producing more insulin would help the bacteria grow faster\nB. whether different types of bacteria would need different nutrients to produce insulin\nC. whether she added enough nutrients to help the bacteria produce 20% more insulin\nAnswer with the option's letter from the given choices directly.",
    "gold": [
      "C"
    ],
    "image": "vlmx-scienceqa_1.png"
  },
  {
    "id": "scienceqa_2",
    "task": "scienceqa",
    "metric": "mc",
    "prompt": "Does this passage describe the weather or the climate?\nContext: Figure: Chicago.\nChicago is known as The Windy City. But on average, the wind there only blows at about 10 miles per hour.\nHint: Weather is what the atmosphere is like at a certain place and time. Climate is the pattern of weather in a certain place.\nA. weather\nB. climate\nAnswer with the option's letter from the given choices directly.",
    "gold": [
      "B"
    ],
    "image": "vlmx-scienceqa_2.png"
  },
  {
    "id": "scienceqa_3",
    "task": "scienceqa",
    "metric": "mc",
    "prompt": "Which animal's feet are also adapted for grabbing prey?\nContext: Bald eagles eat fish, mammals, and other birds. The 's feet are adapted for grabbing prey.\nFigure: bald eagle.\nA. sable\nB. New Zealand falcon\nAnswer with the option's letter from the given choices directly.",
    "gold": [
      "B"
    ],
    "image": "vlmx-scienceqa_3.png"
  },
  {
    "id": "scienceqa_4",
    "task": "scienceqa",
    "metric": "mc",
    "prompt": "Is the following statement about our solar system true or false?\nJupiter's volume is more than 10,000 times as large as the volume of Mars.\nContext: Use the data to answer the question below.\nA. true\nB. false\nAnswer with the option's letter from the given choices directly.",
    "gold": [
      "B"
    ],
    "image": "vlmx-scienceqa_4.png"
  }
]
}
