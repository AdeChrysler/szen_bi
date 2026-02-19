"""Creative agent — generates images via Google Gemini Imagen and commits to repo."""
import os
import base64
from google import genai
from google.genai import types

def generate_image(prompt: str, output_path: str) -> str:
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    response = client.models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            output_mime_type="image/png",
        ),
    )
    if not response.generated_images:
        raise RuntimeError("Gemini returned no images")
    image_bytes = response.generated_images[0].image.image_bytes
    with open(output_path, "wb") as f:
        f.write(image_bytes)
    return output_path

if __name__ == "__main__":
    prompt = os.environ.get("ISSUE_DESCRIPTION", "")
    title = os.environ.get("ISSUE_TITLE", "generated")
    safe_title = title.lower().replace(" ", "-")[:50]
    output = f"/workspace/repo/assets/{safe_title}.png"
    os.makedirs(os.path.dirname(output), exist_ok=True)
    path = generate_image(prompt, output)
    print(f"Generated: {path}")
