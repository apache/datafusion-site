from pelican import signals
import re
from datetime import datetime

def extract_date_from_filename(article):
    regex_pattern = r"(\d{4}-\d{2}-\d{2})-([-_.a-zA-Z0-9]*).md"
    match = re.match(regex_pattern, article.source_path.split('/')[-1])
    if match:
        # Uncomment if in the future we want to use the filename instead
        # of what is in the header info in the markdown file
        
        # extracted_date = datetime.strptime(match.group(1), "%Y-%m-%d")
        # extracted_date = datetime.today()
        # article.metadata['date'] = extracted_date
        article.metadata['filename'] = match.group(2)
    else:
        article.metadata['filename'] = article.source_path.split('/')[-1]

def register():
    signals.content_object_init.connect(extract_date_from_filename)
