#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True)
class Case:
    category: str
    case_id: str
    messages: list[dict[str, object]]
    tools: list[dict[str, object]]


@dataclass(frozen=True)
class Outcome:
    passed: bool
    classification: str
    detail: str
    received_http_response: bool


_CASES_DATA = json.loads(r"""
[
  {
    "category": "live_multiple",
    "case_id": "live_multiple_0-0-0",
    "messages": [
      {
        "role": "user",
        "content": "update my latte to a large size with coconut milk and make it extra sweet? make it served 'boiling hot' as the special request. The drink id is 'latte'"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "ChaFod",
          "description": "Changes the food item based on the customer's request, allowing for modifications to the ingredients or preparation method.",
          "parameters": {
            "type": "object",
            "required": [
              "foodItem"
            ],
            "properties": {
              "foodItem": {
                "type": "string",
                "description": "The name of the food item to be modified as requested by the customer."
              },
              "newIngredients": {
                "type": "string",
                "description": "A comma-separated list of new ingredients to include in the food item, if any.",
                "default": ""
              },
              "removeIngredients": {
                "type": "string",
                "description": "A comma-separated list of ingredients to remove from the food item, if any.",
                "default": ""
              },
              "specialInstructions": {
                "type": "string",
                "description": "Special preparation instructions provided by the customer, such as 'extra spicy' or 'no salt'.",
                "default": ""
              }
            }
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "ChaDri_change_drink",
          "description": "Modifies the existing drink order to accommodate the customer's new request, ensuring the drink is updated according to the specified preferences.",
          "parameters": {
            "type": "object",
            "required": [
              "new_preferences"
            ],
            "properties": {
              "drink_id": {
                "type": "string",
                "description": "The unique identifier of the drink to be changed.",
                "default": "0000-0000-0000"
              },
              "new_preferences": {
                "type": "object",
                "description": "The updated preferences for the drink order.",
                "properties": {
                  "size": {
                    "type": "string",
                    "description": "The size of the drink the customer prefers.",
                    "enum": [
                      "small",
                      "medium",
                      "large"
                    ],
                    "default": "medium"
                  },
                  "temperature": {
                    "type": "string",
                    "description": "The temperature at which the drink should be served.",
                    "enum": [
                      "cold",
                      "warm",
                      "hot"
                    ],
                    "default": "cold"
                  },
                  "sweetness_level": {
                    "type": "string",
                    "description": "The sweetness level the customer requests for the drink.",
                    "enum": [
                      "none",
                      "light",
                      "regular",
                      "extra"
                    ],
                    "default": "regular"
                  },
                  "milk_type": {
                    "type": "string",
                    "description": "The type of milk to be used in the drink, if applicable.",
                    "enum": [
                      "regular",
                      "soy",
                      "almond",
                      "coconut"
                    ],
                    "default": "regular"
                  },
                  "special_instructions": {
                    "type": "string",
                    "description": "Any additional instructions provided by the customer for the drink preparation.",
                    "default": ""
                  }
                }
              }
            }
          }
        }
      }
    ]
  },
  {
    "category": "live_parallel",
    "case_id": "live_parallel_0-0-0",
    "messages": [
      {
        "role": "user",
        "content": "请问北京的当前天气状况如何？还有，上海的天气情况是怎样的？"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_current_weather",
          "description": "Retrieves the current weather conditions for a specified city and state.",
          "parameters": {
            "type": "object",
            "required": [
              "location"
            ],
            "properties": {
              "location": {
                "type": "string",
                "description": "The location for which to get the weather, in the format of 'City, State', such as 'San Francisco, CA' if State for the city exists. 'City, Country' if State for the city doesn't exist."
              },
              "unit": {
                "type": "string",
                "description": "The unit of temperature for the weather report.",
                "enum": [
                  "celsius",
                  "fahrenheit"
                ],
                "default": "fahrenheit"
              }
            }
          }
        }
      }
    ]
  },
  {
    "category": "live_parallel_multiple",
    "case_id": "live_parallel_multiple_0-0-0",
    "messages": [
      {
        "role": "user",
        "content": "I'd like to change my food order to a Caesar salad without anchovies, and for the drink, can you update my order 123 to a large hot coffee with regular sweetness and almond milk, please?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "ChaFod",
          "description": "Changes the food item based on the customer's request, allowing for modifications to the ingredients or preparation method.",
          "parameters": {
            "type": "object",
            "required": [
              "foodItem"
            ],
            "properties": {
              "foodItem": {
                "type": "string",
                "description": "The name of the food item to be modified as requested by the customer."
              },
              "newIngredients": {
                "type": "string",
                "description": "A comma-separated list of new ingredients to include in the food item, if any.",
                "default": ""
              },
              "removeIngredients": {
                "type": "string",
                "description": "A comma-separated list of ingredients to remove from the food item, if any.",
                "default": ""
              },
              "specialInstructions": {
                "type": "string",
                "description": "Special preparation instructions provided by the customer, such as 'extra spicy' or 'no salt'.",
                "default": ""
              }
            }
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "ChaDri_change_drink",
          "description": "Modifies the existing drink order to accommodate the customer's new request, ensuring the drink is updated according to the specified preferences.",
          "parameters": {
            "type": "object",
            "required": [
              "drink_id",
              "new_preferences"
            ],
            "properties": {
              "drink_id": {
                "type": "string",
                "description": "The unique identifier of the drink to be changed."
              },
              "new_preferences": {
                "type": "object",
                "description": "The updated preferences for the drink order.",
                "properties": {
                  "size": {
                    "type": "string",
                    "description": "The size of the drink the customer prefers.",
                    "enum": [
                      "small",
                      "medium",
                      "large"
                    ],
                    "default": "medium"
                  },
                  "temperature": {
                    "type": "string",
                    "description": "The temperature at which the drink should be served.",
                    "enum": [
                      "cold",
                      "warm",
                      "hot"
                    ],
                    "default": "cold"
                  },
                  "sweetness_level": {
                    "type": "string",
                    "description": "The sweetness level the customer requests for the drink.",
                    "enum": [
                      "none",
                      "light",
                      "regular",
                      "extra"
                    ],
                    "default": "regular"
                  },
                  "milk_type": {
                    "type": "string",
                    "description": "The type of milk to be used in the drink, if applicable.",
                    "enum": [
                      "regular",
                      "soy",
                      "almond",
                      "coconut"
                    ],
                    "default": "regular"
                  },
                  "special_instructions": {
                    "type": "string",
                    "description": "Any additional instructions provided by the customer for the drink preparation.",
                    "default": ""
                  }
                }
              }
            }
          }
        }
      }
    ]
  },
  {
    "category": "live_relevance",
    "case_id": "live_relevance_0-0-0",
    "messages": [
      {
        "role": "user",
        "content": "I'd like to have a digital painting created. The image should be a detailed portrait of a masked woman, including bright peacock feathers, with an elegant and highly detailed style. It should have a fluid illustration quality, with green highlighted lines and complex patterns, reminiscent of cyberpunk and Alphonse Mucha's art."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "search_engine_query",
          "description": "Conducts a search based on the provided prompt and returns relevant real-time information, specific details, or general facts from various sources, including internet browsing and data from Google.",
          "parameters": {
            "type": "object",
            "required": [
              "prompt"
            ],
            "properties": {
              "prompt": {
                "type": "string",
                "description": "The search query to be executed by the search engine. Example: 'latest scientific discoveries'."
              },
              "since_year": {
                "type": "integer",
                "description": "Filter results to include only information published after the specified year. Default to the current year if not provided.",
                "default": 2023
              },
              "source": {
                "type": "string",
                "description": "Preferred source for the search results, such as 'all', 'internet', or 'google'.",
                "enum": [
                  "all",
                  "internet",
                  "google"
                ],
                "default": "all"
              },
              "include_facts": {
                "type": "boolean",
                "description": "Indicates whether to include factual information in the search results. Default is true.",
                "default": true
              }
            }
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "generate_image",
          "description": "Generate an image based on a given text prompt. The function is versatile and can be used for various general purposes without specializing in any specific category.",
          "parameters": {
            "type": "object",
            "required": [
              "prompt"
            ],
            "properties": {
              "prompt": {
                "type": "string",
                "description": "The text prompt that describes the desired content of the image."
              },
              "image_format": {
                "type": "string",
                "description": "The file format for the output image.",
                "enum": [
                  "JPEG",
                  "PNG",
                  "BMP"
                ],
                "default": "PNG"
              },
              "width": {
                "type": "integer",
                "description": "The width of the generated image in pixels.",
                "default": 1024
              },
              "height": {
                "type": "integer",
                "description": "The height of the generated image in pixels.",
                "default": 768
              },
              "color_mode": {
                "type": "string",
                "description": "The color mode of the image.",
                "enum": [
                  "RGB",
                  "Grayscale"
                ],
                "default": "RGB"
              }
            }
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "generate_human_image",
          "description": "Generates a realistic image of a human based on the provided prompt, with options for creating images representing different age groups and genders.",
          "parameters": {
            "type": "object",
            "required": [
              "prompt",
              "image_quality"
            ],
            "properties": {
              "prompt": {
                "type": "string",
                "description": "A descriptive text guiding the generation of the human image, such as 'a smiling girl with blue eyes' or 'an elderly man playing chess'."
              },
              "image_quality": {
                "type": "string",
                "description": "The desired quality of the generated image, affecting the level of detail and realism. Options include 'low', 'medium', and 'high'.",
                "enum": [
                  "low",
                  "medium",
                  "high"
                ]
              },
              "include_background": {
                "type": "boolean",
                "description": "Determines whether a background should be included in the generated image.",
                "default": false
              },
              "output_format": {
                "type": "string",
                "description": "Specifies the file format for the output image.",
                "enum": [
                  "JPEG",
                  "PNG",
                  "BMP"
                ],
                "default": "JPEG"
              }
            }
          }
        }
      }
    ]
  },
  {
    "category": "live_simple",
    "case_id": "live_simple_0-0-0",
    "messages": [
      {
        "role": "user",
        "content": "Can you retrieve the details for the user with the ID 7890, who has black as their special request?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_user_info",
          "description": "Retrieve details for a specific user by their unique identifier.",
          "parameters": {
            "type": "object",
            "required": [
              "user_id"
            ],
            "properties": {
              "user_id": {
                "type": "integer",
                "description": "The unique identifier of the user. It is used to fetch the specific user details from the database."
              },
              "special": {
                "type": "string",
                "description": "Any special information or parameters that need to be considered while fetching user details.",
                "default": "none"
              }
            }
          }
        }
      }
    ]
  },
  {
    "category": "multiple",
    "case_id": "multiple_0",
    "messages": [
      {
        "role": "user",
        "content": "Can I find the dimensions and properties of a triangle, if I know its three sides are 5 units, 4 units and 3 units long?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "triangle_properties_get",
          "description": "Retrieve the dimensions, such as area and perimeter, of a triangle if lengths of three sides are given.",
          "parameters": {
            "type": "object",
            "properties": {
              "side1": {
                "type": "integer",
                "description": "The length of first side of the triangle."
              },
              "side2": {
                "type": "integer",
                "description": "The length of second side of the triangle."
              },
              "side3": {
                "type": "integer",
                "description": "The length of third side of the triangle."
              },
              "get_area": {
                "type": "boolean",
                "description": "A flag to determine whether to calculate the area of triangle. Default is true.",
                "default": true,
                "optional": true
              },
              "get_perimeter": {
                "type": "boolean",
                "description": "A flag to determine whether to calculate the perimeter of triangle. Default is true.",
                "default": true,
                "optional": true
              },
              "get_angles": {
                "type": "boolean",
                "description": "A flag to determine whether to calculate the internal angles of triangle. Default is true.",
                "default": true,
                "optional": true
              }
            },
            "required": [
              "side1",
              "side2",
              "side3"
            ]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "circle_properties_get",
          "description": "Retrieve the dimensions, such as area and circumference, of a circle if radius is given.",
          "parameters": {
            "type": "object",
            "properties": {
              "radius": {
                "type": "number",
                "description": "The length of radius of the circle. This is a float type value.",
                "format": "float"
              },
              "get_area": {
                "type": "boolean",
                "description": "A flag to determine whether to calculate the area of circle. Default is true.",
                "default": true,
                "optional": true
              },
              "get_circumference": {
                "type": "boolean",
                "description": "A flag to determine whether to calculate the circumference of circle. Default is true.",
                "default": true,
                "optional": true
              }
            },
            "required": [
              "radius"
            ]
          }
        }
      }
    ]
  },
  {
    "category": "parallel",
    "case_id": "parallel_0",
    "messages": [
      {
        "role": "user",
        "content": "Play songs from the artists Taylor Swift and Maroon 5, with a play time of 20 minutes and 15 minutes respectively, on Spotify."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "spotify_play",
          "description": "Play specific tracks from a given artist for a specific time duration.",
          "parameters": {
            "type": "object",
            "properties": {
              "artist": {
                "type": "string",
                "description": "The artist whose songs you want to play."
              },
              "duration": {
                "type": "integer",
                "description": "The duration for which the songs should be played, in minutes."
              }
            },
            "required": [
              "artist",
              "duration"
            ]
          }
        }
      }
    ]
  },
  {
    "category": "parallel_multiple",
    "case_id": "parallel_multiple_0",
    "messages": [
      {
        "role": "user",
        "content": "Find the sum of all the multiples of 3 and 5 between 1 and 1000. Also find the product of the first five prime numbers."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "math_toolkit_sum_of_multiples",
          "description": "Find the sum of all multiples of specified numbers within a specified range.",
          "parameters": {
            "type": "object",
            "properties": {
              "lower_limit": {
                "type": "integer",
                "description": "The start of the range (inclusive)."
              },
              "upper_limit": {
                "type": "integer",
                "description": "The end of the range (inclusive)."
              },
              "multiples": {
                "type": "array",
                "items": {
                  "type": "integer"
                },
                "description": "The numbers to find multiples of."
              }
            },
            "required": [
              "lower_limit",
              "upper_limit",
              "multiples"
            ]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "math_toolkit_product_of_primes",
          "description": "Find the product of the first n prime numbers.",
          "parameters": {
            "type": "object",
            "properties": {
              "count": {
                "type": "integer",
                "description": "The number of prime numbers to multiply together."
              }
            },
            "required": [
              "count"
            ]
          }
        }
      }
    ]
  },
  {
    "category": "simple_java",
    "case_id": "simple_java_0",
    "messages": [
      {
        "role": "user",
        "content": "Help me initialize the GIS geometry presentation in a user interface, providing a specific result set controller `mapController` and a composite UI element `mapArea` to display the GIS data?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "GeometryPresentation_createPresentation",
          "description": "Initializes the GIS geometry presentation within the provided UI composite, using the given result set controller.",
          "parameters": {
            "type": "object",
            "properties": {
              "controller": {
                "type": "string",
                "description": "The IResultSetController instance responsible for controlling the result set."
              },
              "parent": {
                "type": "string",
                "description": "The Composite UI element where the GIS presentation will be displayed."
              }
            },
            "required": [
              "controller",
              "parent"
            ]
          }
        }
      }
    ]
  },
  {
    "category": "simple_javascript",
    "case_id": "simple_javascript_0",
    "messages": [
      {
        "role": "user",
        "content": "Help me validate user input in a form field with the ID 'userInputField' after the user has finished typing?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "validateUserInput",
          "description": "This function is called after a user has finished typing in a form field, to validate the input provided.",
          "parameters": {
            "type": "object",
            "properties": {
              "inputField": {
                "type": "string",
                "description": "The form field whose input needs to be validated."
              },
              "isComplete": {
                "type": "string",
                "description": "Indicates if the user has finished typing in the input field."
              }
            },
            "required": [
              "inputField",
              "isComplete"
            ]
          }
        }
      }
    ]
  },
  {
    "category": "simple_python",
    "case_id": "simple_python_0",
    "messages": [
      {
        "role": "user",
        "content": "Find the area of a triangle with a base of 10 units and height of 5 units."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "calculate_triangle_area",
          "description": "Calculate the area of a triangle given its base and height.",
          "parameters": {
            "type": "object",
            "properties": {
              "base": {
                "type": "integer",
                "description": "The base of the triangle."
              },
              "height": {
                "type": "integer",
                "description": "The height of the triangle."
              },
              "unit": {
                "type": "string",
                "description": "The unit of measure (defaults to 'units' if not specified)"
              }
            },
            "required": [
              "base",
              "height"
            ]
          }
        }
      }
    ]
  }
]
""")

CASES = tuple(
    Case(
        category=item["category"],
        case_id=item["case_id"],
        messages=item["messages"],
        tools=item["tools"],
    )
    for item in _CASES_DATA
)


def request_payload(case: Case, model: str) -> dict[str, object]:
    return {
        "model": model,
        "messages": case.messages,
        "tools": case.tools,
    }


def excerpt(value: object, limit: int = 300) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else f"{text[:limit]}..."


def evaluate_response(status: int, body: str) -> Outcome:
    if status != 200:
        return Outcome(False, "http_error", f"HTTP {status}: {excerpt(body)}", True)

    try:
        payload = json.loads(body)
        message = payload["choices"][0]["message"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
        return Outcome(
            False,
            "malformed_response",
            f"{error}: {excerpt(body)}",
            True,
        )

    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return Outcome(
            False,
            "missing_tool_calls",
            excerpt(message.get("content")),
            True,
        )

    return Outcome(True, "tool_calls", f"{len(tool_calls)} structured call(s)", True)


def post_case(
    case: Case,
    model: str,
    base_url: str,
    api_key: str,
    timeout: float,
) -> Outcome:
    payload = json.dumps(request_payload(case, model)).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return evaluate_response(response.status, body)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return Outcome(
            False,
            "http_error",
            f"HTTP {error.code}: {excerpt(body)}",
            True,
        )
    except urllib.error.URLError as error:
        return Outcome(False, "unreachable", str(error.reason), False)
    except TimeoutError:
        return Outcome(
            False,
            "unreachable",
            f"timed out after {timeout:g}s",
            False,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reproduce missing OpenAI tool calls with 11 BFCL cases."
    )
    parser.add_argument(
        "--model",
        default=os.environ.get(
            "OPENAI_MODEL",
            "local-qwen35-08b-q4km-think-text",
        ),
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1"),
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("OPENAI_API_KEY", "EMPTY"),
    )
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    return args


def main() -> int:
    args = parse_args()
    print(f"Endpoint: {args.base_url.rstrip('/')}/chat/completions")
    print(f"Model: {args.model}")
    print(f"Cases: {len(CASES)}")

    passed = 0
    failed = 0
    received_http_response = False

    for case in CASES:
        outcome = post_case(
            case=case,
            model=args.model,
            base_url=args.base_url,
            api_key=args.api_key,
            timeout=args.timeout,
        )
        received_http_response = (
            received_http_response or outcome.received_http_response
        )
        if outcome.passed:
            passed += 1
            print(
                f"[PASS] {case.category} / {case.case_id}: {outcome.detail}",
                flush=True,
            )
        else:
            failed += 1
            print(
                f"[FAIL] {case.category} / {case.case_id}: "
                f"{outcome.classification}: {outcome.detail}",
                flush=True,
            )

    print(f"Summary: {passed} passed, {failed} failed, {len(CASES)} total")
    if not received_http_response:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
