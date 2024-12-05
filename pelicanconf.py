import datetime
# Basic information about the site.
SITENAME = 'Apache DataFusion Blog'
SITEDESC = 'The official new and blog for the Apache DataFusion project'
SITEDOMAIN = 'datafusion.apache.org'
SITEURL = 'https://datafusion.apache.org/blog'
SITELOGO = 'https://datafusion.apache.org/favicon.ico'
SITEREPOSITORY = 'https://github.com/apache/datafusion-site/blob/main/content/'
CURRENTYEAR = datetime.date.today().year
TRADEMARKS = 'Apache HTTP Server, Apache, and the Apache feather logo are trademarks of The Apache Software Foundation.'
TIMEZONE = 'UTC'
# Theme includes templates and possibly static files
THEME = 'content/theme'
# Specify location of plugins, and which to use
PLUGIN_PATHS = [ 'plugins',  ]
# If the website uses any *.ezmd files, include the 'asfreader' plugin
# PLUGINS = [ 'toc', 'gfm', 'asfgenid',  ]
# PLUGINS = ['asfgenid', 'asfdata', 'pelican-gfm', 'asfreader', 'sitemap']
PLUGINS = ['asfgenid', 'extract_date_from_filename']
# All content is located at '.' (aka content/ )
PAGE_PATHS = [ 'pages' ]
STATIC_PATHS = [ '.',  ]
# Where to place/link generated pages

PATH_METADATA = 'pages/(?P<path_no_ext>.*)\\..*'

PAGE_SAVE_AS = '{path_no_ext}.html'
# Don't try to translate
PAGE_TRANSLATION_ID = None
# Disable unused Pelican features
# N.B. These features are currently unsupported, see https://github.com/apache/infrastructure-pelican/issues/49
FEED_ALL_ATOM = None
INDEX_SAVE_AS = ''
TAGS_SAVE_AS = ''
CATEGORIES_SAVE_AS = ''
AUTHORS_SAVE_AS = ''
ARCHIVES_SAVE_AS = ''
# Disable articles by pointing to a (should-be-absent) subdir
ARTICLE_PATHS = [ 'blog' ]
# needed to create blogs page
ARTICLE_URL = 'blog/{date:%Y}/{date:%m}/{date:%d}/{filename}'
ARTICLE_SAVE_AS = 'blog/{date:%Y}/{date:%m}/{date:%d}/{filename}/index.html'
# Disable all processing of .html files
READERS = { 'html': None, }

# Configure the asfgenid plugin
ASF_GENID = {
 'unsafe_tags': True,
 'metadata': False,
 'elements': False,
 'permalinks': False,
 'tables': False,
 'headings': False,


 'toc': False,

 'debug': False,
}

# Configure ignore file and directory basenames (paths not checked)
# blogs/README.md is not intended for publication
IGNORE_FILES = [ 'theme', 'README.md' ]

FEED_RSS = "blog/feed.xml"

MARKDOWN = {
    'extension_configs': {
        'markdown.extensions.codehilite': {'linenums': False},
        'markdown.extensions.fenced_code': {},
    },
    'output_format': 'html5',
}