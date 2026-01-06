#!/usr/bin/env python3
"""
Draw OCR bounding boxes on an image.

Usage: python3 examples/draw_boxes.py <input_image> <results_json> <output_image>

Example:
    python3 examples/draw_boxes.py photo.jpg photo_ocr.json photo_annotated.jpg
"""

import json
import sys
from PIL import Image, ImageDraw, ImageFont


def draw_boxes(input_image_path, json_path, output_path):
    # Load image
    img = Image.open(input_image_path)
    draw = ImageDraw.Draw(img)

    # Load OCR results
    with open(json_path, 'r') as f:
        data = json.load(f)

    results = data.get('results', [])

    # Try to load a font, fall back to default
    try:
        # Try common font paths
        font_paths = [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/TTF/DejaVuSans.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        ]
        font = None
        for fp in font_paths:
            try:
                font = ImageFont.truetype(fp, 14)
                break
            except:
                continue
        if font is None:
            font = ImageFont.load_default()
    except:
        font = ImageFont.load_default()

    # Colors for boxes and text
    box_color = (0, 255, 0)  # Green
    text_bg_color = (0, 255, 0, 180)  # Semi-transparent green
    text_color = (0, 0, 0)  # Black

    for i, result in enumerate(results):
        box = result['box']
        text = result['text']
        confidence = result.get('confidence', 0)

        # Box is [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
        # Convert to polygon points
        points = [(int(p[0]), int(p[1])) for p in box]

        # Draw the polygon
        draw.polygon(points, outline=box_color)

        # Draw text above the box
        if text.strip():
            # Get text bounding box
            text_label = f"{text} ({confidence:.0%})"
            bbox = draw.textbbox((0, 0), text_label, font=font)
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]

            # Position text at top-left of bounding box
            text_x = min(p[0] for p in points)
            text_y = min(p[1] for p in points) - text_height - 4

            # Make sure text is visible
            if text_y < 0:
                text_y = max(p[1] for p in points) + 4

            # Draw text background
            draw.rectangle(
                [text_x - 2, text_y - 2, text_x + text_width + 2, text_y + text_height + 2],
                fill=box_color
            )

            # Draw text
            draw.text((text_x, text_y), text_label, fill=text_color, font=font)

    # Save output
    img.save(output_path)
    print(f"Saved annotated image to: {output_path}")
    print(f"Total text regions: {len(results)}")


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 draw_boxes.py <input_image> <results_json> <output_image>")
        print("")
        print("Example:")
        print("  python3 examples/draw_boxes.py photo.jpg photo_ocr.json photo_annotated.jpg")
        sys.exit(1)

    input_image = sys.argv[1]
    json_path = sys.argv[2]
    output_path = sys.argv[3]

    draw_boxes(input_image, json_path, output_path)


if __name__ == '__main__':
    main()
