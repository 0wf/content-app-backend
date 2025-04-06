import sys
import json
import os
import tempfile
from main import process_response

def get_video(responselist):
    print("Processing response:", responselist)
    video_path, tempfiles = process_response(responselist)
    print("Video written. File path:", video_path)
    return video_path

if __name__ == '__main__':
    # Expect a unique ID as an argument
    if len(sys.argv) < 2:
        print("No unique id provided.", file=sys.stderr)
        sys.exit(1)
    unique_id = sys.argv[1]

    try:
        input_data = sys.stdin.read()
        if input_data:
            responselist = json.loads(input_data)
        else:
            responselist = {
                'user': 'Username',
                'story_data': 'https://www.reddit.com/r/fender/comments/1js65b0/series_parallel_on_a_strat/',
                'video': 'minecraft',
                'color': 'white',
                'font': 'Poppins-Bold',
                'voice': 'voice1',
                'ai': True
            }
    except Exception as e:
        print("Error reading JSON from stdin:", e, file=sys.stderr)
        responselist = {
            'user': 'Username',
            'story_data': 'https://www.reddit.com/r/fender/comments/1js65b0/series_parallel_on_a_strat/',
            'video': 'minecraft',
            'color': 'white',
            'font': 'Poppins-Bold',
            'voice': 'voice1',
            'ai': True
        }

    output_file = get_video(responselist)
    # Define a unique output info file name using the unique_id
    output_info_filename = f"output_info_{unique_id}.json"
    # Write the output file path to this JSON file
    with open(output_info_filename, "w") as f:
        json.dump({"output_file": output_file}, f)