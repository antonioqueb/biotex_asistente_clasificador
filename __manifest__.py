{
    'name': 'Asistente Clasificador',
    'summary': 'Variante del asistente de clasificación masiva: marca y folio por producto, clasificación desde el paso 2, paso 3 de solo lectura ordenado por marca y folio, catálogos frescos en cada selector',
    'version': '19.0.1.0.0',
    'category': 'Distribución de insumos',
    'author': 'Alphaqueb Consulting SAS',
    'license': 'LGPL-3',
    'icon': '/biotex_asistente_clasificador/static/description/icon.svg',
    'depends': ['biotex_catalog'],
    'data': [
        'views/classification_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'biotex_asistente_clasificador/static/src/**/*',
        ],
    },
    'installable': True,
    'application': False,
}
