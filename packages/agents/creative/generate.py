"""Creative agent — generates images via OpenAI DALL-E and commits to repo."""
import os
import httpx
from openai import OpenAI

def generate_image(prompt: str, output_path: str, size: str = "1024x1024") -> str:
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    response = client.images.generate(model="dall-e-3", prompt=prompt, size=size, n=1)
    image_url = response.data[0].url
    img_data = httpx.get(image_url).content
    with open(output_path, "wb") as f:
        f.write(img_data)
    return output_path

if __name__ == "__main__":
    prompt = os.environ.get("ISSUE_DESCRIPTION", "")
    title = os.environ.get("ISSUE_TITLE", "generated")
    safe_title = title.lower().replace(" ", "-")[:50]
    output = f"/workspace/repo/assets/{safe_title}.png"
    os.makedirs(os.path.dirname(output), exist_ok=True)
    path = generate_image(prompt, output)
    print(f"Generated: {path}")
