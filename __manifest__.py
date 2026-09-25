{
    'name': 'Clasificador Global',
    'summary': 'Variante del asistente de clasificación masiva: marca y folio por producto; el paso 2 agrega, el paso 3 edita (marca, folio, fotos) con pendientes primero y clasificados por marca y folio; al guardar y salir o generar claves se liberan los productos sin marca ni folio; regla de raíz al guardar y tabla unificada de unidades y empaques',
    'version': '19.0.1.6.0',
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
