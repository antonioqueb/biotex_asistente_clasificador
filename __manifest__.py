{
    'name': 'Clasificador Global',
    'summary': 'Variante del asistente de clasificación masiva: marca y folio por producto, clasificación desde el paso 2, paso 3 ordenado por marca y folio con edición por fila, regla de raíz al guardar y tabla unificada de unidades y empaques',
    'version': '19.0.1.5.0',
    'description': 'Clasificador Global: la sesión fija grupo, familia y clasificador; la marca y el folio se asignan por producto al confirmar la marca. Convive con el Clasificador por Grupos de biotex_catalog.',
    'category': 'Distribución de insumos',
    'author': 'Alphaqueb Consulting SAS',
    'license': 'LGPL-3',
    'icon': '/biotex_asistente_clasificador/static/description/icon.svg',
    'depends': ['biotex_catalog', 'sale'],
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
